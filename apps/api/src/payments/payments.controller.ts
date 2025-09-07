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
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Request, Response } from 'express';
import { Throttle } from '@nestjs/throttler';

import { PaymentsService } from './payments.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { UserRole, ApiResponse } from '@shared/types';

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
  async getOrder(
    @Param('orderId') orderId: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    // Allow both authenticated and guest access
    const userId = req.user?.id;
    const result = await this.paymentsService.getOrder(orderId, userId);
    return { data: result };
  }

  @Get('orders/:orderId/download')
  async getDownloadUrls(
    @Param('orderId') orderId: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    const userId = req.user?.id;
    const result = await this.paymentsService.generateDownloadUrls(orderId, userId);
    return { data: result };
  }

  // Simulate payment completion (for demo mode)
  @Post('orders/:orderId/complete')
  @Throttle(5, 60)
  async completePayment(
    @Param('orderId') orderId: string,
  ): Promise<ApiResponse> {
    const result = await this.paymentsService.processPayment(orderId, 'demo-session-' + Date.now());
    return { data: result };
  }

  @Get('gateways')
  async getAvailableGateways(): Promise<ApiResponse> {
    const gateways = await this.paymentsService.getAvailableGateways();
    return { data: gateways };
  }

  @Get('paypal/return')
  async handlePayPalReturn(
    @Query('token') token: string,
    @Query('PayerID') payerID: string,
    @Res() res: Response,
  ) {
    const result = await this.paymentsService.handlePayPalReturn(token, payerID);
    
    // Redireccionar al frontend con el resultado
    if (result.redirectUrl) {
      return res.redirect(result.redirectUrl);
    }
    
    // Fallback si no hay URL de redirección
    return res.json({ data: result });
  }

  @Get('paypal/cancel')
  async handlePayPalCancel(
    @Query('token') token: string,
    @Res() res: Response,
  ) {
    const result = await this.paymentsService.handlePayPalCancel(token);
    
    // Redireccionar al frontend con el resultado
    if (result.redirectUrl) {
      return res.redirect(result.redirectUrl);
    }
    
    // Fallback si no hay URL de redirección
    return res.json({ data: result });
  }

  @Post('paypal/verify-return')
  @Throttle(20, 60)
  async verifyPayPalReturn(
    @Body() body: { token: string; payerID?: string },
  ): Promise<ApiResponse> {
    const { token, payerID } = body;
    const result = await this.paymentsService.verifyPayPalReturn(token, payerID);
    return { data: result.data };
  }
}