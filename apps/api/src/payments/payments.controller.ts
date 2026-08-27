import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  Query,
  UseGuards,
  Req,
  Res,
  ParseIntPipe,
  DefaultValuePipe,
  Headers,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Request, Response } from 'express';
import { Throttle } from '@nestjs/throttler';

import { PaymentsService } from './payments.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { RefundOrderDto } from './dto/refund-order.dto';
import { UserRole, ApiResponse } from '@shared/types';
import { OptionalJwtAuthGuard } from '../common/guards/optional-jwt.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

interface AuthenticatedRequest extends Request {
  user: {
    id: string;
    email: string;
    role: UserRole;
  };
}

@Controller('payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post('orders')
  @Throttle(10, 60)
  @UseGuards(OptionalJwtAuthGuard)
  async createOrder(
    @Body() createOrderDto: CreateOrderDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    // Allow both authenticated and guest orders
    const userId = req.user?.id;
    const result = await this.paymentsService.createOrder(createOrderDto, userId);
    return { data: result };
  }

  @UseGuards(AuthGuard('jwt'))
  @Get('orders')
  async getUserOrders(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    const result = await this.paymentsService.getUserOrders(req.user.id, page, limit);
    return { 
      data: result.items,
      meta: { pagination: result.pagination },
    };
  }

  @Get('orders/:orderId')
  // Generoso a propósito: tras pagar, la página consulta este pedido varias
  // veces esperando al webhook, y en desarrollo React duplica cada efecto. Con
  // 30 se agotaba el cupo y la pantalla se quedaba en "confirmando" para
  // siempre, culpando a Stripe de un cobro que ya estaba hecho. Es una lectura
  // de un pedido propio protegida por token, así que el riesgo es bajo.
  @Throttle(120, 60)
  @UseGuards(OptionalJwtAuthGuard)
  async getOrder(
    @Param('orderId') orderId: string,
    @Query('token') token: string | undefined,
    @Headers('x-order-access-token') headerToken: string | undefined,
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    // Allow both authenticated and guest access
    const userId = req.user?.id;
    const result = await this.paymentsService.getOrder(orderId, userId, headerToken || token);
    return { data: result };
  }

  @Post('orders/:orderId/confirm')
  // Le pregunta a la pasarela por el cobro en lugar de esperar al webhook. Es
  // lo que se llama al volver de pagar, así que la entrega deja de depender de
  // que el webhook gane la carrera al navegador.
  @Throttle(20, 60)
  @UseGuards(OptionalJwtAuthGuard)
  async confirmOrder(
    @Param('orderId') orderId: string,
    @Query('token') token: string | undefined,
    @Headers('x-order-access-token') headerToken: string | undefined,
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    const userId = req.user?.id;
    const result = await this.paymentsService.confirmOrder(orderId, userId, headerToken || token);
    return { data: result };
  }

  @Get('orders/:orderId/download')
  @Throttle(10, 60)
  @UseGuards(OptionalJwtAuthGuard)
  async getDownloadUrls(
    @Param('orderId') orderId: string,
    @Query('token') token: string | undefined,
    @Headers('x-order-access-token') headerToken: string | undefined,
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    const userId = req.user?.id;
    const result = await this.paymentsService.generateDownloadUrls(orderId, userId, headerToken || token);
    return { data: result };
  }

  @Get('orders/:orderId/download-zip')
  @Throttle(3, 60)
  @UseGuards(OptionalJwtAuthGuard)
  async downloadZip(
    @Param('orderId') orderId: string,
    @Query('token') token: string | undefined,
    @Headers('x-order-access-token') headerToken: string | undefined,
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
  ): Promise<void> {
    const userId = req.user?.id;
    await this.paymentsService.downloadOrderAsZip(orderId, userId, headerToken || token, res);
  }

  // Simulate payment completion (for demo mode)
  @Post('orders/:orderId/complete')
  @Throttle(5, 60)
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN)
  async completePayment(
    @Param('orderId') orderId: string,
  ): Promise<ApiResponse> {
    const result = await this.paymentsService.completeDemoPayment(orderId);
    return { data: result };
  }

  @Get('gateways')
  async getAvailableGateways(): Promise<ApiResponse> {
    const gateways = await this.paymentsService.getAvailableGateways();
    return { data: gateways };
  }

  @Post('settlements/retry')
  @Throttle(5, 60)
  @UseGuards(AuthGuard('jwt'))
  async retrySettlements(@Req() req: AuthenticatedRequest): Promise<ApiResponse> {
    const result = await this.paymentsService.retrySettlements(req.user.id, req.user.role);
    return { data: result };
  }

  @Post('orders/:orderId/refund')
  @Throttle(3, 60)
  @UseGuards(AuthGuard('jwt'), RolesGuard)
  @Roles(UserRole.ADMIN)
  async refundOrder(
    @Param('orderId') orderId: string,
    @Body() dto: RefundOrderDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    const result = await this.paymentsService.refundOrder(orderId, dto.reason, req.user.id, req.user.role);
    return { data: result };
  }

}
