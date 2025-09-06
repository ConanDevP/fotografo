import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../common/services/prisma.service';
import { CloudinaryService } from '../common/services/cloudinary.service';
import { QueueService } from '../common/services/queue.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { EventPricing } from '@shared/types';
import { ERROR_CODES } from '@shared/constants';

@Injectable()
export class PaymentsService {
  constructor(
    private prisma: PrismaService,
    private cloudinaryService: CloudinaryService,
    private queueService: QueueService,
    private configService: ConfigService,
  ) {}

  async createOrder(orderData: CreateOrderDto, userId?: string) {
    const { eventId, items } = orderData;

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

    // In demo mode, auto-approve the order
    const isDemoMode = this.configService.get('DEMO_PAYMENTS', 'false') === 'true';
    
    if (isDemoMode) {
      await this.processPayment(order.id, 'demo-session-id');
      
      return {
        orderId: order.id,
        totalAmount: totalCents,
        currency: pricing.currency,
        status: 'PAID',
        demoMode: true,
        message: 'Pago simulado - Pedido procesado automáticamente',
      };
    }

    // For real Stripe integration (future)
    return {
      orderId: order.id,
      totalAmount: totalCents,
      currency: pricing.currency,
      status: 'CREATED',
      // checkoutUrl: stripeCheckoutUrl (when implemented)
    };
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
      throw new NotFoundException({
        code: ERROR_CODES.ORDER_NOT_FOUND,
        message: 'Pedido no encontrado',
      });
    }

    return order;
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
          const secureUrl = await this.cloudinaryService.generateSecureDownloadUrl(
            item.photo!.originalUrl.split('/').pop()!.split('.')[0], // Extract cloudinary ID
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
}