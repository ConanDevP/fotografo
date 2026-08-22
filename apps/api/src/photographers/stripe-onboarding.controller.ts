import { Controller, Post, Get, Query, Req, Res, UseGuards, Logger, BadRequestException, Optional } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Request, Response } from 'express';
import { PrismaService } from '../common/services/prisma.service';
import { StripeConnectService } from '../payments/gateways/stripe-connect.service';
import { UserRole, ApiResponse } from '@shared/types';

interface AuthenticatedRequest extends Request {
    user: {
        id: string;
        email: string;
        role: UserRole;
    };
}

@Controller('photographers/stripe')
export class StripeOnboardingController {
    private readonly logger = new Logger(StripeOnboardingController.name);

    constructor(
        private prisma: PrismaService,
        @Optional() private stripeConnectService: StripeConnectService,
    ) { }

    /**
     * Start Stripe Connect onboarding for photographer
     * POST /photographers/stripe/onboarding/start
     */
    @UseGuards(AuthGuard('jwt'))
    @Post('onboarding/start')
    async startOnboarding(@Req() req: AuthenticatedRequest): Promise<ApiResponse> {
        if (!this.stripeConnectService) {
            throw new BadRequestException('Stripe no está configurado');
        }

        const userId = req.user.id;

        // Verify user is a photographer
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: {
                id: true,
                email: true,
                role: true,
                stripeOnboardingCompleted: true,
                stripeAccountId: true,
            },
        });

        if (!user) {
            throw new BadRequestException('Usuario no encontrado');
        }

        if (user.role !== 'PHOTOGRAPHER') {
            throw new BadRequestException('Solo fotógrafos y organizadores pueden conectar Stripe');
        }

        // If already onboarded, return dashboard link
        if (user.stripeOnboardingCompleted && user.stripeAccountId) {
            const dashboardUrl = await this.stripeConnectService.createDashboardLink(user.stripeAccountId);
            return {
                data: {
                    alreadyConnected: true,
                    dashboardUrl,
                    message: 'Ya tienes una cuenta Stripe conectada',
                },
            };
        }

        // Create or get Connect account and onboarding link
        const result = await this.stripeConnectService.createConnectAccount(userId, user.email);

        this.logger.log(`Stripe onboarding started for user ${userId}, account: ${result.accountId}`);

        return {
            data: {
                accountId: result.accountId,
                onboardingUrl: result.onboardingUrl,
                message: 'Redirige al fotógrafo a esta URL para completar el onboarding',
            },
        };
    }

    /**
     * Handle callback from Stripe after photographer completes onboarding
     * GET /photographers/stripe/callback?userId=xxx
     */
    @Get('callback')
    async handleCallback(
        @Query('state') state: string,
        @Res() res: Response,
    ): Promise<void> {
        try {
            if (!this.stripeConnectService) {
                throw new BadRequestException('Stripe no está configurado');
            }

            if (!state) throw new BadRequestException('Missing onboarding state');
            const userId = this.stripeConnectService.verifyOnboardingState(state);
            this.logger.log(`Stripe callback received for user: ${userId}`);

            // Refresh account status from Stripe
            const status = await this.stripeConnectService.refreshAccountStatus(userId);

            if (!status) {
                throw new BadRequestException('No se encontró cuenta de Stripe para este usuario');
            }

            this.logger.log(`Stripe account status refreshed for user ${userId}`, {
                chargesEnabled: status.chargesEnabled,
                payoutsEnabled: status.payoutsEnabled,
                detailsSubmitted: status.detailsSubmitted,
            });

            // Redirect to frontend success page
            const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
            const redirectUrl = `${frontendUrl}/dashboard/photographer/stripe/callback?accountId=${status.accountId}&chargesEnabled=${status.chargesEnabled}&payoutsEnabled=${status.payoutsEnabled}`;

            this.logger.log(`Redirecting to frontend: ${redirectUrl}`);
            res.redirect(redirectUrl);

        } catch (error) {
            this.logger.error('Error handling Stripe callback', error);

            // Redirect to frontend error page
            const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            res.redirect(`${frontendUrl}/dashboard/photographer/stripe/callback?error=${encodeURIComponent(errorMessage)}`);
        }
    }

    /**
     * Handle refresh URL when onboarding link expires
     * GET /photographers/stripe/refresh?userId=xxx
     */
    @Get('refresh')
    async handleRefresh(
        @Query('state') state: string,
        @Res() res: Response,
    ): Promise<void> {
        try {
            if (!this.stripeConnectService) {
                throw new BadRequestException('Stripe no está configurado');
            }

            if (!state) throw new BadRequestException('Missing onboarding state');
            const userId = this.stripeConnectService.verifyOnboardingState(state);
            this.logger.log(`Stripe refresh requested for user: ${userId}`);

            const user = await this.prisma.user.findUnique({
                where: { id: userId },
                select: { stripeAccountId: true },
            });

            if (!user?.stripeAccountId) {
                throw new BadRequestException('No se encontró cuenta de Stripe');
            }

            // Create new onboarding link
            const accountLink = await this.stripeConnectService.createAccountLink(user.stripeAccountId, userId);

            // Redirect to new onboarding URL
            res.redirect(accountLink.url);

        } catch (error) {
            this.logger.error('Error handling Stripe refresh', error);

            const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            res.redirect(`${frontendUrl}/dashboard/photographer/stripe/callback?error=${encodeURIComponent(errorMessage)}`);
        }
    }

    /**
     * Get current photographer's Stripe connection status
     * GET /photographers/stripe/status
     */
    @UseGuards(AuthGuard('jwt'))
    @Get('status')
    async getStripeStatus(@Req() req: AuthenticatedRequest): Promise<ApiResponse> {
        const userId = req.user.id;

        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: {
                stripeAccountId: true,
                stripeAccountStatus: true,
                stripeOnboardingCompleted: true,
                stripeChargesEnabled: true,
                stripePayoutsEnabled: true,
                stripeOnboardedAt: true,
            },
        });

        if (!user) {
            throw new BadRequestException('Usuario no encontrado');
        }

        return {
            data: {
                connected: user.stripeOnboardingCompleted,
                accountId: user.stripeAccountId,
                accountStatus: user.stripeAccountStatus,
                chargesEnabled: user.stripeChargesEnabled,
                payoutsEnabled: user.stripePayoutsEnabled,
                onboardedAt: user.stripeOnboardedAt,
                readyToReceivePayments: user.stripeChargesEnabled && user.stripePayoutsEnabled,
            },
        };
    }

    /**
     * Refresh account status from Stripe
     * POST /photographers/stripe/refresh-status
     */
    @UseGuards(AuthGuard('jwt'))
    @Post('refresh-status')
    async refreshStatus(@Req() req: AuthenticatedRequest): Promise<ApiResponse> {
        if (!this.stripeConnectService) {
            throw new BadRequestException('Stripe no está configurado');
        }

        const userId = req.user.id;

        const status = await this.stripeConnectService.refreshAccountStatus(userId);

        if (!status) {
            throw new BadRequestException('No tienes una cuenta Stripe conectada');
        }

        return {
            data: {
                accountId: status.accountId,
                chargesEnabled: status.chargesEnabled,
                payoutsEnabled: status.payoutsEnabled,
                detailsSubmitted: status.detailsSubmitted,
                requirements: status.requirements,
                readyToReceivePayments: status.chargesEnabled && status.payoutsEnabled,
            },
        };
    }

    /**
     * Get Stripe Express dashboard link
     * GET /photographers/stripe/dashboard
     */
    @UseGuards(AuthGuard('jwt'))
    @Get('dashboard')
    async getDashboardLink(@Req() req: AuthenticatedRequest): Promise<ApiResponse> {
        if (!this.stripeConnectService) {
            throw new BadRequestException('Stripe no está configurado');
        }

        const userId = req.user.id;

        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: { stripeAccountId: true, stripeOnboardingCompleted: true },
        });

        if (!user?.stripeAccountId || !user.stripeOnboardingCompleted) {
            throw new BadRequestException('No tienes una cuenta Stripe conectada');
        }

        const dashboardUrl = await this.stripeConnectService.createDashboardLink(user.stripeAccountId);

        return {
            data: {
                dashboardUrl,
                message: 'Enlace al dashboard de Stripe Express',
            },
        };
    }

    /**
     * Get account balance
     * GET /photographers/stripe/balance
     */
    @UseGuards(AuthGuard('jwt'))
    @Get('balance')
    async getBalance(@Req() req: AuthenticatedRequest): Promise<ApiResponse> {
        if (!this.stripeConnectService) {
            throw new BadRequestException('Stripe no está configurado');
        }

        const userId = req.user.id;

        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: { stripeAccountId: true, stripeOnboardingCompleted: true },
        });

        if (!user?.stripeAccountId || !user.stripeOnboardingCompleted) {
            throw new BadRequestException('No tienes una cuenta Stripe conectada');
        }

        const balance = await this.stripeConnectService.getAccountBalance(user.stripeAccountId);

        return {
            data: {
                available: balance.available.map(b => ({
                    amount: b.amount,
                    currency: b.currency,
                })),
                pending: balance.pending.map(b => ({
                    amount: b.amount,
                    currency: b.currency,
                })),
            },
        };
    }
}
