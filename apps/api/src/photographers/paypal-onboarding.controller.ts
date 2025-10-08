import { Controller, Post, Get, Query, Req, Res, UseGuards, Logger, BadRequestException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Request, Response } from 'express';
import { PrismaService } from '../common/services/prisma.service';
import { PayPalPartnerService } from '../payments/gateways/paypal-partner.service';
import { UserRole, ApiResponse } from '@shared/types';

interface AuthenticatedRequest extends Request {
  user: {
    id: string;
    email: string;
    role: UserRole;
  };
}

@Controller('photographers/paypal')
export class PayPalOnboardingController {
  private readonly logger = new Logger(PayPalOnboardingController.name);

  constructor(
    private prisma: PrismaService,
    private paypalPartnerService: PayPalPartnerService,
  ) {}

  /**
   * Generate PayPal onboarding link for photographer
   * POST /photographers/paypal/onboarding/link
   */
  @UseGuards(AuthGuard('jwt'))
  @Post('onboarding/link')
  async generateOnboardingLink(@Req() req: AuthenticatedRequest): Promise<ApiResponse> {
    const userId = req.user.id;

    // Verify user is a photographer
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        role: true,
        paypalOnboardingCompleted: true,
        paypalMerchantId: true,
      },
    });

    if (!user) {
      throw new BadRequestException('Usuario no encontrado');
    }

    if (user.role !== UserRole.PHOTOGRAPHER) {
      throw new BadRequestException('Solo los fotógrafos pueden conectar PayPal');
    }

    if (user.paypalOnboardingCompleted && user.paypalMerchantId) {
      throw new BadRequestException('Ya tienes una cuenta PayPal conectada');
    }

    // Generate tracking ID (using user ID)
    const trackingId = `photographer-${userId}`;

    // Generate referral link - debe ir al BACKEND primero
    const backendUrl = process.env.API_URL || 'http://localhost:8080';
    const actionUrl = await this.paypalPartnerService.generateReferralLink(
      trackingId,
      `${backendUrl}/v1/photographers/paypal/callback`
    );

    // Save tracking ID
    await this.prisma.user.update({
      where: { id: userId },
      data: { paypalTrackingId: trackingId },
    });

    this.logger.log(`PayPal onboarding link generated for user ${userId}`);

    return {
      data: {
        actionUrl,
        trackingId,
        message: 'Redirige al fotógrafo a esta URL para completar el onboarding',
      },
    };
  }

  /**
   * Handle callback from PayPal after photographer completes onboarding
   * GET /photographers/paypal/callback?merchantId=xxx&merchantIdInPayPal=xxx&permissionsGranted=true&...
   */
  @Get('callback')
  async handleCallback(
    @Query('merchantId') merchantId: string,
    @Query('merchantIdInPayPal') merchantIdInPayPal: string,
    @Query('permissionsGranted') permissionsGranted: string,
    @Query('consentStatus') consentStatus: string,
    @Query('productIntentId') productIntentId: string,
    @Query('isEmailConfirmed') isEmailConfirmed: string,
    @Query('accountStatus') accountStatus: string,
    @Res() res: Response,
  ): Promise<void> {
    try {
      this.logger.log('PayPal callback received', {
        merchantId,
        merchantIdInPayPal,
        permissionsGranted,
        accountStatus,
      });

      if (!merchantId || !merchantIdInPayPal) {
        throw new BadRequestException('Missing required parameters');
      }

      // PayPal returns:
      // - merchantId: OUR tracking_id that we sent (photographer-UUID)
      // - merchantIdInPayPal: PayPal's merchant ID for the photographer
      const ourTrackingId = merchantId; // This is photographer-{userId}

      const user = await this.prisma.user.findFirst({
        where: {
          OR: [
            { paypalTrackingId: ourTrackingId },
            { paypalMerchantId: ourTrackingId },
          ],
        },
      });

      if (!user) {
        this.logger.error(`User not found for merchantId: ${merchantId}, merchantIdInPayPal: ${merchantIdInPayPal}`);
        throw new BadRequestException('Usuario no encontrado para este tracking ID');
      }

      // Update user with PayPal info
      const isOnboardingComplete = permissionsGranted === 'true' && (accountStatus === 'ACCOUNT_CREATED' || accountStatus === 'BUSINESS_ACCOUNT');

      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          paypalMerchantId: merchantIdInPayPal, // PayPal's merchant ID (FX6VJKZ3NFHVG)
          paypalMerchantIdInPayPal: merchantIdInPayPal,
          paypalPermissionsGranted: permissionsGranted === 'true',
          paypalOnboardingCompleted: isOnboardingComplete,
          paypalOnboardedAt: isOnboardingComplete ? new Date() : undefined,
        },
      });

      this.logger.log(`User ${user.id} PayPal data updated`, {
        merchantId,
        isOnboardingComplete,
      });

      // Verify merchant status with PayPal
      try {
        const merchantStatus = await this.paypalPartnerService.getMerchantStatus(merchantIdInPayPal);

        // Update email if provided by PayPal
        if (merchantStatus.primary_email && !user.paypalEmail) {
          await this.prisma.user.update({
            where: { id: user.id },
            data: { paypalEmail: merchantStatus.primary_email },
          });
        }

        this.logger.log(`Merchant status verified for ${merchantIdInPayPal}`, {
          paymentsReceivable: merchantStatus.payments_receivable,
          emailConfirmed: merchantStatus.primary_email_confirmed,
        });
      } catch (error) {
        this.logger.warn('Could not verify merchant status immediately', error);
      }

      // Redirect to frontend success page
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
      const redirectUrl = `${frontendUrl}/dashboard/photographer/paypal/callback?merchantId=${merchantIdInPayPal}&merchantIdInPayPal=${merchantIdInPayPal}&permissionsGranted=${permissionsGranted}&accountStatus=${accountStatus}`;

      this.logger.log(`Redirecting to frontend: ${redirectUrl}`);
      res.redirect(redirectUrl);

    } catch (error) {
      this.logger.error('Error handling PayPal callback', error);

      // Redirect to frontend error page
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      res.redirect(`${frontendUrl}/dashboard/photographer/paypal/callback?error=${encodeURIComponent(errorMessage)}`);
    }
  }

  /**
   * Get current photographer's PayPal connection status
   * GET /photographers/paypal/status
   */
  @UseGuards(AuthGuard('jwt'))
  @Get('status')
  async getPayPalStatus(@Req() req: AuthenticatedRequest): Promise<ApiResponse> {
    const userId = req.user.id;

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        paypalMerchantId: true,
        paypalEmail: true,
        paypalOnboardingCompleted: true,
        paypalPermissionsGranted: true,
        paypalOnboardedAt: true,
      },
    });

    if (!user) {
      throw new BadRequestException('Usuario no encontrado');
    }

    // In sandbox, consider ready if onboarding is completed and permissions granted
    // In production, we would verify with PayPal's merchant status API
    const isReady = user.paypalOnboardingCompleted && user.paypalPermissionsGranted;

    return {
      data: {
        connected: user.paypalOnboardingCompleted,
        merchantId: user.paypalMerchantId,
        email: user.paypalEmail,
        permissionsGranted: user.paypalPermissionsGranted,
        onboardedAt: user.paypalOnboardedAt,
        readyToReceivePayments: isReady,
      },
    };
  }

  /**
   * Refresh merchant status from PayPal
   * POST /photographers/paypal/refresh-status
   */
  @UseGuards(AuthGuard('jwt'))
  @Post('refresh-status')
  async refreshStatus(@Req() req: AuthenticatedRequest): Promise<ApiResponse> {
    const userId = req.user.id;

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { paypalMerchantId: true },
    });

    if (!user?.paypalMerchantId) {
      throw new BadRequestException('No tienes una cuenta PayPal conectada');
    }

    // In sandbox, merchant status API may not work without Partner approval
    // Just return current status from database
    const currentUser = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        paypalEmail: true,
        paypalOnboardingCompleted: true,
        paypalPermissionsGranted: true,
      },
    });

    return {
      data: {
        paymentsReceivable: currentUser.paypalOnboardingCompleted,
        emailConfirmed: currentUser.paypalOnboardingCompleted,
        email: currentUser.paypalEmail,
        message: 'Estado actual (sandbox mode)',
      },
    };
  }
}
