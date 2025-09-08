import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../common/services/prisma.service';
import { StorageService } from '../common/services/storage.service';
import { QueueService } from '../common/services/queue.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { EventPricing } from '@shared/types';
import { ERROR_CODES } from '@shared/constants';
import { PaymentGatewayFactory } from './factories/payment-gateway.factory';
import { 
  PaymentGateway, 
  PaymentRequest, 
  PaymentItem, 
  PaymentStatus,
  PaymentConfirmation 
} from '@shared/payment-types';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  
  constructor(
    private prisma: PrismaService,
    private storageService: StorageService,
    private queueService: QueueService,
    private configService: ConfigService,
    private paymentGatewayFactory: PaymentGatewayFactory,
  ) {}

  async createOrder(orderData: CreateOrderDto, userId?: string) {
    const { eventId, items, gateway = PaymentGateway.DEMO, currency, returnUrl, cancelUrl } = orderData;

    // Validate event exists and get pricing
    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
      select: { 
        id: true, 
        name: true, 
        pricing: true,
      },
    });

    if (!event) {
      throw new NotFoundException({
        code: ERROR_CODES.EVENT_NOT_FOUND,
        message: 'Evento no encontrado',
      });
    }

    const pricing = event.pricing as unknown as EventPricing;
    if (!pricing) {
      throw new BadRequestException({
        code: ERROR_CODES.VALIDATION_ERROR,
        message: 'Evento no tiene precios configurados',
      });
    }

    // Calculate total amount
    let totalCents = 0;
    const validatedItems = [];

    for (const item of items) {
      let itemPrice = 0;

      if (item.type === 'PHOTO') {
        // Validate photo exists and belongs to event
        const photo = await this.prisma.photo.findFirst({
          where: {
            id: item.photoId,
            eventId,
            status: 'PROCESSED',
          },
        });

        if (!photo) {
          throw new BadRequestException({
            code: ERROR_CODES.PHOTO_NOT_FOUND,
            message: `Foto ${item.photoId} no encontrada`,
          });
        }

        itemPrice = pricing.singlePhoto;
      } else if (item.type === 'PACKAGE') {
        // Handle different package types
        switch (item.packageType) {
          case 'pack5':
            itemPrice = pricing.pack5;
            break;
          case 'pack10':
            itemPrice = pricing.pack10;
            break;
          case 'allPhotos':
            itemPrice = pricing.allPhotos;
            break;
          default:
            throw new BadRequestException({
              code: ERROR_CODES.VALIDATION_ERROR,
              message: 'Tipo de paquete inválido',
            });
        }
      }

      totalCents += itemPrice;
      validatedItems.push({
        ...item,
        priceCents: itemPrice,
      });
    }

    // Create order
    const order = await this.prisma.order.create({
      data: {
        userId,
        eventId,
        amountCents: totalCents,
        currency: pricing.currency,
        status: 'CREATED',
      },
    });

    // Create order items
    await this.prisma.orderItem.createMany({
      data: validatedItems.map(item => ({
        orderId: order.id,
        photoId: item.photoId,
        itemType: item.type,
        priceCents: item.priceCents,
      })),
    });

    // Determinar si usar modo demo o pasarela real
    const isDemoMode = this.configService.get('DEMO_PAYMENTS', 'false') === 'true' || gateway === PaymentGateway.DEMO;
    
    if (isDemoMode && gateway === PaymentGateway.DEMO) {
      await this.processPayment(order.id, 'demo-session-id');
      
      return {
        orderId: order.id,
        paymentId: 'demo-payment-' + order.id,
        totalAmount: totalCents,
        currency: pricing.currency,
        status: 'PAID',
        gateway: PaymentGateway.DEMO,
        demoMode: true,
        message: 'Pago simulado - Pedido procesado automáticamente',
      };
    }

    // Usar pasarela real (PayPal, Stripe, MercadoPago)
    const finalCurrency = currency || pricing.currency;
    const frontendUrl = this.configService.get('FRONTEND_URL', 'http://localhost:3000');
    
    const paymentRequest: PaymentRequest = {
      orderId: order.id,
      eventId,
      totalAmount: totalCents,
      currency: finalCurrency,
      returnUrl: returnUrl || `${frontendUrl}/payment/success`,
      cancelUrl: cancelUrl || `${frontendUrl}/payment/cancel`,
      description: `Compra de ${validatedItems.length} foto(s) - ${event.name}`,
      items: validatedItems.map((item, index) => ({
        name: item.type === 'PHOTO' ? `Foto ${index + 1}` : `Paquete ${item.packageType}`,
        description: `${event.name} - ${item.type === 'PHOTO' ? 'Foto individual' : 'Paquete de fotos'}`,
        quantity: 1,
        unitAmount: item.priceCents,
        photoId: item.photoId,
      })),
    };

    try {
      const paymentGateway = this.paymentGatewayFactory.createGateway(gateway);
      const paymentResponse = await paymentGateway.createPayment(paymentRequest);
      
      // Actualizar orden con ID de pago de la pasarela
      await this.prisma.order.update({
        where: { id: order.id },
        data: {
          stripeSessionId: paymentResponse.paymentId, // Reutilizamos este campo para todas las pasarelas
        },
      });

      return {
        orderId: paymentResponse.orderId,
        paymentId: paymentResponse.paymentId,
        totalAmount: paymentResponse.totalAmount,
        currency: paymentResponse.currency,
        status: paymentResponse.status,
        gateway: paymentResponse.gateway,
        redirectUrl: paymentResponse.redirectUrl,
        metadata: paymentResponse.metadata,
      };
    } catch (error) {
      // Si falla la creación del pago, marcar orden como fallida
      await this.prisma.order.update({
        where: { id: order.id },
        data: { status: 'CANCELLED' },
      });
      
      throw error;
    }
  }

  async processPayment(orderId: string, sessionId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        items: {
          include: {
            photo: true,
          },
        },
        event: {
          select: { name: true },
        },
        user: {
          select: { email: true },
        },
      },
    });

    if (!order) {
      throw new NotFoundException({
        code: ERROR_CODES.ORDER_NOT_FOUND,
        message: 'Pedido no encontrado',
      });
    }

    if (order.status === 'PAID') {
      return { message: 'Pedido ya procesado' };
    }

    // Update order status
    await this.prisma.order.update({
      where: { id: orderId },
      data: {
        status: 'PAID',
        stripeSessionId: sessionId,
      },
    });

    // Send confirmation email if user has email
    if (order.user?.email) {
      await this.queueService.addSendEmailJob({
        eventId: order.eventId!,
        bib: '', // Not applicable for purchase confirmation
        email: order.user.email,
        photoIds: order.items.map(item => item.photoId!).filter(Boolean),
      });
    }

    return { message: 'Pago procesado correctamente' };
  }

  async getOrder(orderId: string, userId?: string) {
    try {
      const where: any = { id: orderId };
      if (userId) {
        where.userId = userId;
      }

      const order = await this.prisma.order.findUnique({
        where,
        include: {
          items: {
            include: {
              photo: {
                select: {
                  id: true,
                  cloudinaryId: true,
                  thumbUrl: true,
                  watermarkUrl: true,
                  originalUrl: true,
                  takenAt: true,
                },
              },
            },
          },
          event: {
            select: { name: true },
          },
        },
      });

      if (!order) {
        console.log(`Order not found: ${orderId}, userId: ${userId || 'none'}`);
        throw new NotFoundException({
          code: ERROR_CODES.ORDER_NOT_FOUND,
          message: 'Pedido no encontrado',
        });
      }

      return order;
    } catch (error) {
      console.error(`Error getting order ${orderId}:`, error);
      if (error instanceof NotFoundException) {
        throw error;
      }
      throw new NotFoundException({
        code: ERROR_CODES.ORDER_NOT_FOUND,
        message: 'Error al buscar el pedido',
      });
    }
  }

  async generateDownloadUrls(orderId: string, userId?: string) {
    const order = await this.getOrder(orderId, userId);

    if (order.status !== 'PAID') {
      throw new BadRequestException({
        code: ERROR_CODES.PAYMENT_FAILED,
        message: 'El pedido no está pagado',
      });
    }

    const downloadUrls = await Promise.all(
      order.items
        .filter(item => item.photo)
        .map(async item => {
          const secureUrl = await this.storageService.generateSecureDownloadUrl(
            item.photo!.cloudinaryId,
            300 // 5 minutes expiry
          );

          return {
            photoId: item.photo!.id,
            downloadUrl: secureUrl,
            expiresAt: new Date(Date.now() + 300 * 1000).toISOString(),
          };
        })
    );

    return {
      orderId,
      downloads: downloadUrls,
      expiresInMinutes: 5,
    };
  }

  async getUserOrders(userId: string, page = 1, limit = 20) {
    const skip = (page - 1) * limit;

    const [orders, total] = await Promise.all([
      this.prisma.order.findMany({
        where: { userId },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          event: {
            select: { name: true },
          },
          _count: {
            select: { items: true },
          },
        },
      }),
      this.prisma.order.count({
        where: { userId },
      }),
    ]);

    return {
      items: orders,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  async confirmPaymentFromWebhook(
    paymentId: string, 
    gateway: PaymentGateway, 
    webhookData?: any
  ): Promise<{ success: boolean; orderId?: string }> {
    try {
      // Buscar orden por payment ID - buscar tanto CREATED como ya procesadas
      let order = await this.prisma.order.findFirst({
        where: { 
          stripeSessionId: paymentId, // Campo que usamos para todas las pasarelas
          status: 'CREATED',
        },
        include: {
          items: {
            include: {
              photo: true,
            },
          },
          event: {
            select: { name: true },
          },
          user: {
            select: { email: true },
          },
        },
      });

      // Si no encontramos con status CREATED, buscar sin filtro de status
      if (!order) {
        order = await this.prisma.order.findFirst({
          where: { 
            stripeSessionId: paymentId,
          },
          include: {
            items: {
              include: {
                photo: true,
              },
            },
            event: {
              select: { name: true },
            },
            user: {
              select: { email: true },
            },
          },
        });
      }

      if (!order) {
        this.logger.error(`Order not found for payment ID: ${paymentId}`);
        // Log todas las órdenes para debugging
        const allOrders = await this.prisma.order.findMany({
          select: { id: true, stripeSessionId: true, status: true },
          take: 10,
          orderBy: { createdAt: 'desc' },
        });
        this.logger.debug('Last 10 orders:', allOrders);
        throw new NotFoundException(`Order not found for payment ID: ${paymentId}`);
      }

      this.logger.log(`Order found: ${order.id}, current status: ${order.status}`);

      // Si ya está pagada, confirmar que está bien procesada
      if (order.status === 'PAID') {
        this.logger.log(`Order ${order.id} already processed, webhook arrived after redirect handling`);
        return {
          success: true,
          orderId: order.id,
        };
      }

      // Usar la pasarela correspondiente para confirmar el pago
      const paymentGateway = this.paymentGatewayFactory.createGateway(gateway);
      const confirmation: PaymentConfirmation = await paymentGateway.confirmPayment(paymentId, webhookData);

      // Actualizar estado de la orden según confirmación
      let orderStatus: 'CREATED' | 'PAID' | 'CANCELLED' | 'REFUNDED';
      switch (confirmation.status) {
        case PaymentStatus.APPROVED:
          orderStatus = 'PAID';
          break;
        case PaymentStatus.PENDING:
          orderStatus = 'CREATED'; // Mantener como creada hasta confirmación final
          break;
        case PaymentStatus.FAILED:
        case PaymentStatus.CANCELLED:
          orderStatus = 'CANCELLED';
          break;
        default:
          orderStatus = 'CREATED';
      }

      await this.prisma.order.update({
        where: { id: order.id },
        data: { status: orderStatus },
      });

      // Si el pago fue aprobado, enviar email de confirmación
      if (confirmation.status === PaymentStatus.APPROVED && order.user?.email) {
        await this.queueService.addSendEmailJob({
          eventId: order.eventId!,
          bib: '', // No aplicable para confirmaciones de compra
          email: order.user.email,
          photoIds: order.items.map(item => item.photoId!).filter(Boolean),
        });
      }

      return {
        success: confirmation.status === PaymentStatus.APPROVED,
        orderId: order.id,
      };
    } catch (error) {
      this.logger.error(`Error confirming payment ${paymentId}:`, error);
      return { success: false };
    }
  }

  async getAvailableGateways() {
    const supportedGateways = this.paymentGatewayFactory.getSupportedGateways();
    const isDemoMode = this.configService.get('DEMO_PAYMENTS', 'false') === 'true';
    
    return {
      gateways: supportedGateways.map(gateway => ({
        id: gateway,
        name: this.getGatewayDisplayName(gateway),
        enabled: true,
      })),
      demoMode: isDemoMode,
    };
  }

  async handlePayPalReturn(token: string, payerID: string) {
    try {
      this.logger.log(`Processing PayPal return: token=${token}, payerID=${payerID}`);
      
      const order = await this.prisma.order.findFirst({
        where: { stripeSessionId: token },
        select: { id: true, status: true },
      });

      if (!order) {
        this.logger.error(`Order not found for token: ${token}`);
        throw new NotFoundException('Orden no encontrada');
      }

      this.logger.log(`Order found: ${order.id}, current status: ${order.status}`);

      // SIEMPRE confirmar el pago cuando llegue la redirección
      // No dependemos del webhook para esto
      let finalStatus = order.status;
      
      if (order.status === 'CREATED') {
        try {
          this.logger.log('Confirming payment with PayPal...');
          const paymentGateway = this.paymentGatewayFactory.createGateway(PaymentGateway.PAYPAL);
          const confirmation = await paymentGateway.confirmPayment(token, { payerID });
          
          this.logger.log(`PayPal confirmation status: ${confirmation.status}`);
          
          // Actualizar según confirmación de PayPal
          finalStatus = confirmation.status === PaymentStatus.APPROVED ? 'PAID' : 'CREATED';
          
          await this.prisma.order.update({
            where: { id: order.id },
            data: { status: finalStatus },
          });

          // Si el pago fue aprobado, enviar email de confirmación
          if (finalStatus === 'PAID') {
            const orderWithDetails = await this.prisma.order.findUnique({
              where: { id: order.id },
              include: {
                items: true,
                user: { select: { email: true } },
              },
            });

            if (orderWithDetails?.user?.email) {
              await this.queueService.addSendEmailJob({
                eventId: orderWithDetails.eventId!,
                bib: '',
                email: orderWithDetails.user.email,
                photoIds: orderWithDetails.items.map(item => item.photoId!).filter(Boolean),
              });
            }
          }
        } catch (confirmError) {
          this.logger.error('Error confirming PayPal payment:', confirmError);
          finalStatus = 'CREATED'; // Mantener como creada si falla la confirmación
        }
      }

      return {
        success: finalStatus === 'PAID',
        orderId: order.id,
        status: finalStatus === 'PAID' ? 'paid' : 'pending',
        message: finalStatus === 'PAID' ? 'Pago completado exitosamente' : 'Pago en proceso',
        redirectUrl: `${this.configService.get('FRONTEND_URL', 'http://localhost:3000')}/payment/${finalStatus === 'PAID' ? 'success' : 'pending'}?orderId=${order.id}`,
      };
    } catch (error) {
      this.logger.error('Error handling PayPal return:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const frontendUrl = this.configService.get('FRONTEND_URL', 'http://localhost:3000');
      
      return {
        success: false,
        error: errorMessage,
        redirectUrl: `${frontendUrl}/payment/error?error=${encodeURIComponent(errorMessage)}`,
      };
    }
  }

  async handlePayPalCancel(token: string) {
    try {
      this.logger.log(`Processing PayPal cancel: token=${token}`);
      
      const order = await this.prisma.order.findFirst({
        where: { stripeSessionId: token },
        select: { id: true },
      });

      if (order) {
        await this.prisma.order.update({
          where: { id: order.id },
          data: { status: 'CANCELLED' },
        });
        this.logger.log(`Order ${order.id} marked as cancelled`);
      }

      const frontendUrl = this.configService.get('FRONTEND_URL', 'http://localhost:3000');

      return {
        success: true,
        orderId: order?.id,
        status: 'cancelled',
        message: 'Pago cancelado',
        redirectUrl: `${frontendUrl}/payment/cancelled${order ? `?orderId=${order.id}` : ''}`,
      };
    } catch (error) {
      this.logger.error('Error handling PayPal cancel:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const frontendUrl = this.configService.get('FRONTEND_URL', 'http://localhost:3000');
      
      return {
        success: false,
        error: errorMessage,
        redirectUrl: `${frontendUrl}/payment/error?error=${encodeURIComponent(errorMessage)}`,
      };
    }
  }

  async verifyPayPalReturn(token: string, payerID?: string) {
    try {
      this.logger.log(`Verifying PayPal return: token=${token}, payerID=${payerID}`);
      
      // Buscar orden por token PayPal (guardado en stripeSessionId)
      const order = await this.prisma.order.findFirst({
        where: { 
          stripeSessionId: token,
          status: { not: 'CANCELLED' },
        },
        include: {
          event: { select: { name: true } },
          _count: { select: { items: true } },
        },
      });

      if (!order) {
        this.logger.error(`Order not found for PayPal token: ${token}`);
        throw new NotFoundException({
          code: 'PAYMENT_NOT_FOUND',
          message: 'No se encontró la orden con este token de PayPal',
        });
      }

      this.logger.log(`Order found: ${order.id}, status: ${order.status}`);

      return {
        success: true,
        data: {
          orderId: order.id,
          status: order.status,
          eventName: order.event?.name,
          itemCount: order._count.items,
          paymentDetails: {
            paypalToken: token,
            payerID: payerID,
            amount: order.amountCents,
            currency: order.currency,
          },
        },
      };
    } catch (error) {
      this.logger.error('Error verifying PayPal return:', error);
      if (error instanceof NotFoundException) {
        throw error;
      }
      
      throw new BadRequestException({
        code: 'VERIFICATION_ERROR',
        message: 'Error al verificar el retorno de PayPal',
      });
    }
  }

  private getGatewayDisplayName(gateway: PaymentGateway): string {
    switch (gateway) {
      case PaymentGateway.PAYPAL:
        return 'PayPal';
      case PaymentGateway.STRIPE:
        return 'Stripe';
      case PaymentGateway.MERCADOPAGO:
        return 'MercadoPago';
      case PaymentGateway.DEMO:
        return 'Demo Mode';
      default:
        return gateway;
    }
  }
}