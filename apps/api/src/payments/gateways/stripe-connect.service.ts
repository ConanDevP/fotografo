import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { PrismaService } from '../../common/services/prisma.service';

export interface ConnectAccountStatus {
    accountId: string;
    chargesEnabled: boolean;
    payoutsEnabled: boolean;
    detailsSubmitted: boolean;
    requirements: {
        currentlyDue: string[];
        eventuallyDue: string[];
        pastDue: string[];
    };
}

@Injectable()
export class StripeConnectService {
    private readonly logger = new Logger(StripeConnectService.name);
    private readonly stripe: Stripe;
    private readonly frontendUrl: string;

    constructor(
        private configService: ConfigService,
        private prisma: PrismaService,
    ) {
        const secretKey = this.configService.get('STRIPE_SECRET_KEY');

        if (!secretKey) {
            throw new Error('Stripe secret key not configured');
        }

        this.stripe = new Stripe(secretKey, {
            apiVersion: '2022-11-15',
        });

        this.frontendUrl = this.configService.get('FRONTEND_URL', 'http://localhost:3000');
        this.logger.log('Stripe Connect Service configured');
    }

    /**
     * Create a Stripe Connect account for a photographer
     * Uses Express accounts for simpler onboarding
     */
    async createConnectAccount(userId: string, email: string): Promise<{ accountId: string; onboardingUrl: string }> {
        try {
            // Check if user already has a Stripe account
            const user = await this.prisma.user.findUnique({
                where: { id: userId },
                select: { stripeAccountId: true, email: true, name: true },
            });

            if (user?.stripeAccountId) {
                // User already has account, generate new onboarding link
                const accountLink = await this.createAccountLink(user.stripeAccountId, userId);
                return {
                    accountId: user.stripeAccountId,
                    onboardingUrl: accountLink.url,
                };
            }

            // Create new Express account
            const account = await this.stripe.accounts.create({
                type: 'express',
                country: 'US', // Default, will be updated during onboarding
                email: email,
                capabilities: {
                    card_payments: { requested: true },
                    transfers: { requested: true },
                },
                business_type: 'individual',
                metadata: {
                    userId: userId,
                    platform: 'fotocorredor',
                },
            });

            this.logger.log(`Stripe Connect account created: ${account.id} for user ${userId}`);

            // Save account ID to user
            await this.prisma.user.update({
                where: { id: userId },
                data: {
                    stripeAccountId: account.id,
                    stripeAccountStatus: 'pending',
                    stripeOnboardingCompleted: false,
                    stripeChargesEnabled: false,
                    stripePayoutsEnabled: false,
                },
            });

            // Create account link for onboarding
            const accountLink = await this.createAccountLink(account.id, userId);

            return {
                accountId: account.id,
                onboardingUrl: accountLink.url,
            };
        } catch (error) {
            this.logger.error('Error creating Stripe Connect account', error);
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            throw new BadRequestException('Error al crear cuenta de Stripe: ' + errorMessage);
        }
    }

    /**
     * Create an account link for onboarding or updating
     */
    async createAccountLink(accountId: string, userId: string): Promise<Stripe.AccountLink> {
        try {
            // URLs point to backend first to update status, then redirect to frontend
            const apiUrl = this.configService.get('API_URL', 'http://localhost:8080');

            const accountLink = await this.stripe.accountLinks.create({
                account: accountId,
                refresh_url: `${apiUrl}/v1/photographers/stripe/refresh?userId=${userId}`,
                return_url: `${apiUrl}/v1/photographers/stripe/callback?userId=${userId}`,
                type: 'account_onboarding',
            });

            return accountLink;
        } catch (error) {
            this.logger.error(`Error creating account link for ${accountId}`, error);
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            throw new BadRequestException('Error al generar enlace de Stripe: ' + errorMessage);
        }
    }

    /**
     * Get the status of a Connect account
     */
    async getAccountStatus(accountId: string): Promise<ConnectAccountStatus> {
        try {
            const account = await this.stripe.accounts.retrieve(accountId);

            return {
                accountId: account.id,
                chargesEnabled: account.charges_enabled,
                payoutsEnabled: account.payouts_enabled,
                detailsSubmitted: account.details_submitted || false,
                requirements: {
                    currentlyDue: account.requirements?.currently_due || [],
                    eventuallyDue: account.requirements?.eventually_due || [],
                    pastDue: account.requirements?.past_due || [],
                },
            };
        } catch (error) {
            this.logger.error(`Error getting account status for ${accountId}`, error);
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            throw new BadRequestException('Error al obtener estado de cuenta: ' + errorMessage);
        }
    }

    /**
     * Refresh account status and update database
     */
    async refreshAccountStatus(userId: string): Promise<ConnectAccountStatus | null> {
        try {
            const user = await this.prisma.user.findUnique({
                where: { id: userId },
                select: { stripeAccountId: true },
            });

            if (!user?.stripeAccountId) {
                return null;
            }

            const status = await this.getAccountStatus(user.stripeAccountId);

            // Update user record
            const isOnboarded = status.chargesEnabled && status.payoutsEnabled && status.detailsSubmitted;

            await this.prisma.user.update({
                where: { id: userId },
                data: {
                    stripeAccountStatus: isOnboarded ? 'active' : 'pending',
                    stripeOnboardingCompleted: isOnboarded,
                    stripeChargesEnabled: status.chargesEnabled,
                    stripePayoutsEnabled: status.payoutsEnabled,
                    stripeOnboardedAt: isOnboarded ? new Date() : undefined,
                },
            });

            this.logger.log(`Account status refreshed for user ${userId}: charges=${status.chargesEnabled}, payouts=${status.payoutsEnabled}`);

            return status;
        } catch (error) {
            this.logger.error(`Error refreshing account status for user ${userId}`, error);
            return null;
        }
    }

    /**
     * Handle account.updated webhook
     */
    async handleAccountUpdated(account: Stripe.Account): Promise<void> {
        try {
            const userId = account.metadata?.userId;

            if (!userId) {
                this.logger.warn(`Account ${account.id} has no userId in metadata`);
                return;
            }

            const isOnboarded = account.charges_enabled && account.payouts_enabled && account.details_submitted;

            await this.prisma.user.update({
                where: { id: userId },
                data: {
                    stripeAccountStatus: isOnboarded ? 'active' : account.details_submitted ? 'restricted' : 'pending',
                    stripeOnboardingCompleted: isOnboarded,
                    stripeChargesEnabled: account.charges_enabled,
                    stripePayoutsEnabled: account.payouts_enabled,
                    stripeOnboardedAt: isOnboarded ? new Date() : undefined,
                },
            });

            this.logger.log(`Account ${account.id} updated via webhook: charges=${account.charges_enabled}, payouts=${account.payouts_enabled}`);
        } catch (error) {
            this.logger.error(`Error handling account.updated for ${account.id}`, error);
        }
    }

    /**
     * Create a login link for the Express dashboard
     */
    async createDashboardLink(accountId: string): Promise<string> {
        try {
            const loginLink = await this.stripe.accounts.createLoginLink(accountId);
            return loginLink.url;
        } catch (error) {
            this.logger.error(`Error creating dashboard link for ${accountId}`, error);
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            throw new BadRequestException('Error al crear enlace del dashboard: ' + errorMessage);
        }
    }

    /**
     * Get balance for a Connect account
     */
    async getAccountBalance(accountId: string): Promise<Stripe.Balance> {
        try {
            const balance = await this.stripe.balance.retrieve({
                stripeAccount: accountId,
            });
            return balance;
        } catch (error) {
            this.logger.error(`Error getting balance for ${accountId}`, error);
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            throw new BadRequestException('Error al obtener balance: ' + errorMessage);
        }
    }

    /**
     * Check if a user has a fully onboarded Stripe account
     */
    async isUserOnboarded(userId: string): Promise<boolean> {
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: { stripeOnboardingCompleted: true, stripeChargesEnabled: true },
        });

        return user?.stripeOnboardingCompleted === true && user?.stripeChargesEnabled === true;
    }

    /**
     * Get Stripe account ID for a user
     */
    async getUserStripeAccountId(userId: string): Promise<string | null> {
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: { stripeAccountId: true, stripeOnboardingCompleted: true },
        });

        if (user?.stripeAccountId && user?.stripeOnboardingCompleted) {
            return user.stripeAccountId;
        }

        return null;
    }
}
