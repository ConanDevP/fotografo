import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Throttle } from '@nestjs/throttler';
import { ApiResponse, UserRole } from '@shared/types';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { ManualPayoutsService } from './manual-payouts.service';
import { MarkPayoutPaidDto } from './dto/mark-payout-paid.dto';
import { MarkPayoutRecoveredDto } from './dto/mark-payout-recovered.dto';

/** Saldos por pagar a mano (a quien aún no puede recibir transferencias de Stripe). Solo administradores. */
@Controller('admin/payouts')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(UserRole.ADMIN)
export class ManualPayoutsController {
  constructor(private readonly payouts: ManualPayoutsService) {}

  @Get()
  async overview(): Promise<ApiResponse> {
    return { data: await this.payouts.overview() };
  }

  @Post('mark-paid')
  @Throttle(20, 60)
  async markPaid(@Body() dto: MarkPayoutPaidDto, @Req() req: { user: { id: string } }): Promise<ApiResponse> {
    return { data: await this.payouts.markPaid(req.user.id, dto) };
  }

  @Post('mark-recovered')
  @Throttle(20, 60)
  async markRecovered(@Body() dto: MarkPayoutRecoveredDto, @Req() req: { user: { id: string } }): Promise<ApiResponse> {
    return { data: await this.payouts.markRecovered(req.user.id, dto) };
  }
}
