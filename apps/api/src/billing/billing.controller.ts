import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { PlanAudience } from '@prisma/client';
import { ApiResponse } from '@shared/types';

import { BillingService } from './billing.service';
import { ChangePlanDto } from './dto/change-plan.dto';
import { SavePaymentMethodDto } from './dto/save-payment-method.dto';

@Controller()
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  /** Catálogo público: alimenta la página de precios. */
  @Get('billing/plans')
  async plans(@Query('audience') audience?: string): Promise<ApiResponse> {
    const parsed =
      audience && Object.values(PlanAudience).includes(audience as PlanAudience)
        ? (audience as PlanAudience)
        : undefined;
    return { data: await this.billing.listPlans(parsed) };
  }

  @Get('workspaces/:workspaceId/billing')
  @UseGuards(AuthGuard('jwt'))
  async overview(@Param('workspaceId') workspaceId: string, @Req() req: any): Promise<ApiResponse> {
    return { data: await this.billing.overview(workspaceId, req.user.id, req.user.role) };
  }

  /** Qué costará publicar este evento en modo compartir, antes de pulsar. */
  @Get('events/:eventId/billing/publication-estimate')
  @UseGuards(AuthGuard('jwt'))
  async publicationEstimate(@Param('eventId') eventId: string): Promise<ApiResponse> {
    return { data: await this.billing.estimatePublication(eventId) };
  }

  @Post('workspaces/:workspaceId/billing/payment-method/setup')
  @UseGuards(AuthGuard('jwt'))
  async setupPaymentMethod(
    @Param('workspaceId') workspaceId: string,
    @Req() req: any,
  ): Promise<ApiResponse> {
    return {
      data: await this.billing.startPaymentMethodSetup(workspaceId, req.user.id, req.user.role),
    };
  }

  @Post('workspaces/:workspaceId/billing/payment-method')
  @UseGuards(AuthGuard('jwt'))
  async savePaymentMethod(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: SavePaymentMethodDto,
    @Req() req: any,
  ): Promise<ApiResponse> {
    return {
      data: await this.billing.confirmPaymentMethod(
        workspaceId,
        dto.paymentMethodId,
        req.user.id,
        req.user.role,
      ),
    };
  }

  @Post('workspaces/:workspaceId/billing/plan')
  @UseGuards(AuthGuard('jwt'))
  async changePlan(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: ChangePlanDto,
    @Req() req: any,
  ): Promise<ApiResponse> {
    return {
      data: await this.billing.changePlan(
        workspaceId,
        dto.planSlug,
        dto.extraStorageBlocks ?? 0,
        req.user.id,
        req.user.role,
      ),
    };
  }
}
