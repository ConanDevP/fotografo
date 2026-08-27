import { Injectable, NotFoundException, BadRequestException, ForbiddenException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Response } from 'express';
import * as archiver from 'archiver';
import { PrismaService } from '../common/services/prisma.service';
import { StorageService } from '../common/services/storage.service';
import { QueueService } from '../common/services/queue.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { EventPricing, ItemType, UserRole } from '@shared/types';
import { ERROR_CODES } from '@shared/constants';
import { PaymentGatewayFactory } from './factories/payment-gateway.factory';
import { BillingService } from '../billing/billing.service';
import {
  PaymentGateway,
  PaymentRequest,
  PaymentItem,
  PaymentStatus,
  PaymentConfirmation
} from '@shared/payment-types';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { StripeGatewayService } from './gateways/stripe-gateway.service';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private prisma: PrismaService,
    private storageService: StorageService,
    private queueService: QueueService,
    private configService: ConfigService,
    private paymentGatewayFactory: PaymentGatewayFactory,
    private billingService: BillingService,
  ) { }

  async createOrder(orderData: CreateOrderDto, userId?: string) {
    const {
      eventId,
      items,
      gateway = PaymentGateway.STRIPE,
      currency,
      guestEmail,
      idempotencyKey,
      acceptedRefundPolicy,
    } = orderData;

    if (gateway === PaymentGateway.DEMO && this.configService.get('DEMO_PAYMENTS', 'false') !== 'true') {
      throw new ForbiddenException('Los pagos de demostración están deshabilitados');
    }
    if (!this.paymentGatewayFactory.getSupportedGateways().includes(gateway)) {
      throw new BadRequestException(`La pasarela ${gateway} no está disponible`);
    }

    const scopedIdempotencyKey = idempotencyKey
      ? this.hashIdempotencyKey(`${userId || guestEmail || 'guest'}:${eventId}:${idempotencyKey}`)
      : undefined;
    const accessToken = this.createAccessToken(scopedIdempotencyKey || randomBytes(32).toString('hex'));

    if (scopedIdempotencyKey) {
      const existingOrder = await this.prisma.order.findUnique({ where: { idempotencyKey: scopedIdempotencyKey } });
      if (existingOrder) {
        const redirectUrl = await this.getReplayRedirectUrl(existingOrder.paymentGateway, existingOrder.stripeSessionId);
        return {
          orderId: existingOrder.id,
          paymentId: existingOrder.paymentId || existingOrder.stripeSessionId,
          totalAmount: existingOrder.amountCents,
          currency: existingOrder.currency,
          status: existingOrder.status,
          gateway: existingOrder.paymentGateway,
          downloadToken: accessToken,
          redirectUrl,
          idempotentReplay: true,
        };
      }
    }

    // Validate event exists and get pricing
    const event = await this.prisma.event.findFirst({
      where: { id: eventId, deletedAt: null, isPublished: true },
      select: {
        id: true,
        name: true,
        pricing: true,
        platformFeePercent: true,
        workspaceId: true,
        commerceMode: true,
        organizerCommissionPercent: true,
        contributors: {
          where: { status: 'ACCEPTED' },
          select: { photographerWorkspaceId: true, organizerCommissionPercent: true },
        },
        owner: {
          select: {
            id: true,
            paypalMerchantId: true,
            paypalOnboardingCompleted: true,
            stripeAccountId: true,
            stripeOnboardingCompleted: true,
            stripeChargesEnabled: true,
          },
        },
      },
    });

    if (!event) {
      throw new NotFoundException({
        code: ERROR_CODES.EVENT_NOT_FOUND,
        message: 'Evento no encontrado',
      });
    }

    if (event.commerceMode === 'FREE') {
      throw new BadRequestException('Este evento ofrece descargas gratuitas y no acepta pedidos pagados');
    }

    const pricing = event.pricing as unknown as EventPricing;
    if (!pricing || !this.isValidPricing(pricing)) {
      throw new BadRequestException({
        code: ERROR_CODES.VALIDATION_ERROR,
        message: 'El evento no tiene precios válidos configurados',
      });
    }

    if (currency && currency.toUpperCase() !== pricing.currency.toUpperCase()) {
      throw new BadRequestException('La moneda del pedido no coincide con la moneda del evento');
    }

    let totalCents = 0;
    const usedPhotoIds = new Set<string>();
    const validatedItems: Array<{
      type: ItemType;
      photoId: string;
      packageType?: 'pack5' | 'pack10' | 'allPhotos';
      priceCents: number;
      beneficiaryWorkspaceId: string | null;
    }> = [];

    for (const item of items) {
      if (item.type === 'PHOTO') {
        if (!item.photoId || usedPhotoIds.has(item.photoId)) {
          throw new BadRequestException('Cada foto del pedido debe ser única y tener un identificador válido');
        }
        const photo = await this.prisma.photo.findFirst({
          where: {
            id: item.photoId,
            eventId,
            status: 'PROCESSED',
            publicationStatus: 'APPROVED',
          },
          select: { id: true, photographerWorkspaceId: true },
        });

        if (!photo) {
          throw new BadRequestException({
            code: ERROR_CODES.PHOTO_NOT_FOUND,
            message: `Foto ${item.photoId} no encontrada`,
          });
        }

        usedPhotoIds.add(photo.id);
        totalCents += pricing.singlePhoto;
        validatedItems.push({
          type: ItemType.PHOTO,
          photoId: photo.id,
          priceCents: pricing.singlePhoto,
          beneficiaryWorkspaceId: photo.photographerWorkspaceId || event.workspaceId,
        });
        continue;
      }

      const packagePrices = {
        pack5: pricing.pack5,
        pack10: pricing.pack10,
        allPhotos: pricing.allPhotos,
      };
      const packageType = item.packageType;
      if (!packageType || packagePrices[packageType] === undefined) {
        throw new BadRequestException('Tipo de paquete inválido');
      }
      const photoIds = [...new Set(item.photoIds || [])];
      if (usedPhotoIds.size + photoIds.length > 100) {
        throw new BadRequestException('Un pedido no puede contener más de 100 fotografías');
      }
      const expectedCount = packageType === 'pack5' ? 5 : packageType === 'pack10' ? 10 : null;
      if (photoIds.length === 0 || (expectedCount !== null && photoIds.length !== expectedCount)) {
        throw new BadRequestException(
          expectedCount ? `El paquete ${packageType} requiere exactamente ${expectedCount} fotos` : 'Selecciona al menos una foto para el paquete',
        );
      }
      if (photoIds.some(photoId => usedPhotoIds.has(photoId))) {
        throw new BadRequestException('Una foto no puede aparecer más de una vez en el pedido');
      }
      const photos = await this.prisma.photo.findMany({
        where: {
          id: { in: photoIds },
          eventId,
          status: 'PROCESSED',
          publicationStatus: 'APPROVED',
        },
        select: { id: true, photographerWorkspaceId: true },
      });
      if (photos.length !== photoIds.length) {
        throw new BadRequestException('El paquete contiene fotos inválidas o no publicadas');
      }

      // `allPhotos` significa "todas las fotos de un dorsal", pero no se estaba
      // comprobando: aceptaba cualquier cantidad de fotografías sueltas al
      // precio del lote completo. Con 7,99 $ la unidad y 95,88 $ el lote, cien
      // fotografías cualesquiera costaban 95,88 en vez de 799. Cualquiera que
      // llamara a la API directamente pagaba una novena parte.
      if (packageType === 'allPhotos') {
        await this.assertCoversWholeSet(eventId, photoIds);
      }

      const packagePrice = packagePrices[packageType];
      const basePrice = Math.floor(packagePrice / photos.length);
      const remainder = packagePrice - basePrice * photos.length;
      photos.forEach((photo, index) => {
        usedPhotoIds.add(photo.id);
        validatedItems.push({
          type: ItemType.PACKAGE,
          photoId: photo.id,
          packageType,
          priceCents: basePrice + (index < remainder ? 1 : 0),
          beneficiaryWorkspaceId: photo.photographerWorkspaceId || event.workspaceId,
        });
      });
      totalCents += packagePrice;
    }

    if (!Number.isSafeInteger(totalCents) || totalCents < 1 || totalCents > 100_000_000) {
      throw new BadRequestException('El total del pedido excede el importe permitido');
    }

    let order;
    try {
      order = await this.prisma.$transaction(async transaction => {
        const createdOrder = await transaction.order.create({
          data: {
            userId,
            eventId,
            amountCents: totalCents,
            currency: pricing.currency,
            status: 'CREATED',
            guestEmail,
            paymentGateway: gateway,
            accessTokenHash: this.hashAccessToken(accessToken),
            accessTokenExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
            idempotencyKey: scopedIdempotencyKey,
            // Marca de tiempo de la aceptación, no un simple booleano: en una
            // disputa lo que vale es poder decir cuándo la aceptó.
            refundPolicyAcceptedAt: acceptedRefundPolicy ? new Date() : null,
          },
        });
        await transaction.orderItem.createMany({
          data: validatedItems.map(item => ({
            orderId: createdOrder.id,
            photoId: item.photoId,
            itemType: item.type,
            priceCents: item.priceCents,
            beneficiaryWorkspaceId: item.beneficiaryWorkspaceId,
          })),
        });
        return createdOrder;
      });
    } catch (error) {
      const racedOrder = scopedIdempotencyKey
        ? await this.prisma.order.findUnique({ where: { idempotencyKey: scopedIdempotencyKey } })
        : null;
      if (racedOrder) {
        const redirectUrl = await this.getReplayRedirectUrl(racedOrder.paymentGateway, racedOrder.stripeSessionId);
        return {
          orderId: racedOrder.id,
          paymentId: racedOrder.paymentId || racedOrder.stripeSessionId,
          totalAmount: racedOrder.amountCents,
          currency: racedOrder.currency,
          status: racedOrder.status,
          gateway: racedOrder.paymentGateway,
          downloadToken: accessToken,
          redirectUrl,
          idempotentReplay: true,
        };
      }
      throw error;
    }

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
        downloadToken: accessToken,
      };
    }

    // Usar pasarela real (PayPal, Stripe, MercadoPago)
    const finalCurrency = pricing.currency;
    const frontendUrl = this.configService.get('FRONTEND_URL', 'http://localhost:3000');
    const finalReturnUrl = this.validateRedirectUrl(orderData.returnUrl, `${frontendUrl}/payment/success`);
    const finalCancelUrl = this.validateRedirectUrl(orderData.cancelUrl, `${frontendUrl}/payment/cancel`);

    const platformFeePercent = Number(event.platformFeePercent || 0);
    const transferGroup = `lucilamon_order_${order.id}`;

    const paymentRequest: PaymentRequest = {
      orderId: order.id,
      eventId,
      totalAmount: totalCents,
      currency: finalCurrency,
      returnUrl: finalReturnUrl,
      cancelUrl: finalCancelUrl,
      description: `Compra de ${validatedItems.length} foto(s) - ${event.name}`,
      items: validatedItems.map((item, index) => ({
        name: item.type === 'PHOTO' ? `Foto ${index + 1}` : `Paquete ${item.packageType}`,
        description: `${event.name} - ${item.type === 'PHOTO' ? 'Foto individual' : 'Paquete de fotos'}`,
        quantity: 1,
        unitAmount: item.priceCents,
        photoId: item.photoId,
      })),
      platformFeePercent,
      transferGroup: gateway === PaymentGateway.STRIPE ? transferGroup : undefined,
      downloadToken: accessToken,
    };

    try {
      const paymentGateway = this.paymentGatewayFactory.createGateway(gateway);
      const paymentResponse = await paymentGateway.createPayment(paymentRequest);

      // Actualizar orden con ID de pago de la pasarela
      await this.prisma.order.update({
        where: { id: order.id },
        data: {
          stripeSessionId: paymentResponse.paymentId, // Reutilizamos este campo para todas las pasarelas
          paymentId: paymentResponse.paymentId,
          stripeTransferGroup: gateway === PaymentGateway.STRIPE ? transferGroup : null,
          settlementStatus: gateway === PaymentGateway.STRIPE ? 'PENDING' : 'NOT_REQUIRED',
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
        downloadToken: accessToken,
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
      await this.queueOrderConfirmation(order.id);
      return { message: 'Pedido ya procesado' };
    }

    await this.markOrderPaid(orderId, sessionId);
    await this.queueOrderConfirmation(orderId);

    return { message: 'Pago procesado correctamente' };
  }

  async completeDemoPayment(orderId: string) {
    if (this.configService.get('DEMO_PAYMENTS', 'false') !== 'true') {
      throw new ForbiddenException('Los pagos de demostración están deshabilitados');
    }
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order || order.paymentGateway !== PaymentGateway.DEMO) {
      throw new NotFoundException('Pedido de demostración no encontrado');
    }
    return this.processPayment(orderId, `demo-session-${Date.now()}`);
  }

  async getOrder(orderId: string, userId?: string, accessToken?: string) {
    const order = await this.getOrderWithStorage(orderId, userId, accessToken);

    return {
      id: order.id,
      eventId: order.eventId,
      amountCents: order.amountCents,
      currency: order.currency,
      status: order.status,
      paymentGateway: order.paymentGateway,
      paidAt: order.paidAt,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
      event: order.event,
      items: order.items.map(item => ({
        id: item.id,
        photoId: item.photoId,
        itemType: item.itemType,
        priceCents: item.priceCents,
        photo: item.photo ? {
          id: item.photo.id,
          thumbUrl: item.photo.thumbUrl,
          watermarkUrl: item.photo.watermarkUrl,
          takenAt: item.photo.takenAt,
        } : null,
      })),
    };
  }

  /**
   * Confirma el pedido en el momento en que el comprador vuelve de la pasarela.
   *
   * Antes esta pantalla solo sabía leer el pedido y esperaba a que llegase el
   * webhook, preguntando una y otra vez. Eso hacía depender la entrega de una
   * carrera que no controlamos: si el webhook tardaba, el comprador veía
   * "confirmando" sobre un cobro ya hecho.
   *
   * Aquí se le pregunta a la pasarela por la sesión, que es la fuente de
   * verdad, y se liquida igual que lo haría el webhook. El webhook sigue
   * siendo imprescindible como red: cubre a quien cierra la pestaña al pagar.
   *
   * La sesión se toma del propio pedido, nunca de la URL: así nadie puede
   * presentar la sesión de otro para que se le confirme este.
   */
  async confirmOrder(orderId: string, userId?: string, accessToken?: string) {
    const order = await this.getOrderWithStorage(orderId, userId, accessToken);

    const settled = ['PAID', 'CANCELLED', 'REFUNDED'].includes(order.status);
    if (!settled && order.paymentGateway === PaymentGateway.STRIPE && order.stripeSessionId) {
      await this.confirmPaymentFromWebhook(order.stripeSessionId, PaymentGateway.STRIPE);
    }

    return this.getOrder(orderId, userId, accessToken);
  }

  private async getOrderWithStorage(orderId: string, userId?: string, accessToken?: string) {
    try {
      const order = await this.prisma.order.findUnique({
        where: { id: orderId },
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
            select: { name: true, workspaceId: true },
          },
        },
      });

      if (!order) {
        throw new NotFoundException({
          code: ERROR_CODES.ORDER_NOT_FOUND,
          message: 'Pedido no encontrado',
        });
      }

      this.assertOrderAccess(order, userId, accessToken);

      return order;
    } catch (error) {
      if (error instanceof NotFoundException || error instanceof ForbiddenException) {
        throw error;
      }
      this.logger.error(`No se pudo consultar el pedido ${orderId}`);
      throw new NotFoundException({
        code: ERROR_CODES.ORDER_NOT_FOUND,
        message: 'Error al buscar el pedido',
      });
    }
  }

  async generateDownloadUrls(orderId: string, userId?: string, accessToken?: string) {
    const order = await this.getOrderWithStorage(orderId, userId, accessToken);

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
            900,
          );

          return {
            photoId: item.photo!.id,
            downloadUrl: secureUrl,
            expiresAt: new Date(Date.now() + 900 * 1000).toISOString(),
          };
        })
    );

    await this.recordPaidDownloadMetric(order, 'direct_urls', downloadUrls.length);

    return {
      orderId,
      downloads: downloadUrls,
      expiresInSeconds: 900,
    };
  }

  async getUserOrders(userId: string, page = 1, limit = 20) {
    page = Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1;
    limit = Number.isFinite(limit) ? Math.min(100, Math.max(1, Math.floor(limit))) : 20;
    const skip = (page - 1) * limit;

    const [orders, total] = await Promise.all([
      this.prisma.order.findMany({
        where: { userId },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          eventId: true,
          amountCents: true,
          currency: true,
          status: true,
          paymentGateway: true,
          paidAt: true,
          createdAt: true,
          updatedAt: true,
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
        this.logger.error('Order not found for verified payment event');
        throw new NotFoundException('Order not found for verified payment event');
      }

      this.logger.log(`Order found: ${order.id}, current status: ${order.status}`);

      // Si ya está pagada, confirmar que está bien procesada
      if (order.status === 'PAID') {
        this.logger.log(`Order ${order.id} already processed, webhook arrived after redirect handling`);
        if (order.paymentGateway === PaymentGateway.STRIPE) await this.settleStripeOrder(order.id);
        await this.queueOrderConfirmation(order.id);
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

      if (orderStatus === 'PAID') {
        if (confirmation.paidAmount !== undefined && confirmation.paidAmount !== order.amountCents) {
          this.logger.error(`Amount mismatch for order ${order.id}: expected ${order.amountCents}, got ${confirmation.paidAmount}`);
          return { success: false, orderId: order.id };
        }
        if (confirmation.paidCurrency && confirmation.paidCurrency.toUpperCase() !== order.currency.toUpperCase()) {
          this.logger.error(`Currency mismatch for order ${order.id}: expected ${order.currency}, got ${confirmation.paidCurrency}`);
          return { success: false, orderId: order.id };
        }
        await this.markOrderPaid(order.id, confirmation.transactionId || paymentId);
        await this.queueOrderConfirmation(order.id);
      } else {
        await this.prisma.order.update({
          where: { id: order.id },
          data: { status: orderStatus },
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

  async confirmStripeIntentFromWebhook(input: {
    orderId: string;
    paymentIntentId: string;
    amountReceived: number;
    currency: string;
  }): Promise<{ success: boolean; orderId?: string }> {
    const order = await this.prisma.order.findUnique({ where: { id: input.orderId } });
    if (!order || order.paymentGateway !== PaymentGateway.STRIPE) {
      this.logger.warn(`Stripe informó un PaymentIntent para un pedido desconocido: ${input.orderId}`);
      return { success: false };
    }
    if (order.status === 'PAID') {
      await this.settleStripeOrder(order.id);
      await this.queueOrderConfirmation(order.id);
      return { success: true, orderId: order.id };
    }
    if (input.amountReceived !== order.amountCents || input.currency.toUpperCase() !== order.currency.toUpperCase()) {
      this.logger.error(`Stripe PaymentIntent no coincide con el importe o moneda del pedido ${order.id}`);
      return { success: false, orderId: order.id };
    }
    await this.markOrderPaid(order.id, input.paymentIntentId);
    await this.queueOrderConfirmation(order.id);
    return { success: true, orderId: order.id };
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
      this.logger.log('Processing PayPal return');

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
      this.logger.log('Processing PayPal cancellation');

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
      this.logger.log('Verifying PayPal return');

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
        this.logger.error('Order not found for PayPal return');
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

  async downloadOrderAsZip(orderId: string, userId: string | undefined, accessToken: string | undefined, res: Response): Promise<void> {
    const order = await this.getOrderWithStorage(orderId, userId, accessToken);

    if (order.status !== 'PAID') {
      throw new BadRequestException({
        code: ERROR_CODES.PAYMENT_FAILED,
        message: 'El pedido no está pagado',
      });
    }

    const photos = order.items.filter(item => item.photo);
    if (photos.length === 0) {
      throw new BadRequestException({
        code: ERROR_CODES.PHOTO_NOT_FOUND,
        message: 'No hay fotos para descargar',
      });
    }

    // Configure response headers for ZIP download
    const eventName = order.event?.name || 'Fotos';
    const zipFilename = `${eventName.replace(/[^a-zA-Z0-9]/g, '_')}_${orderId.slice(-8)}.zip`;

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${zipFilename}"`);
    res.setHeader('Cache-Control', 'no-cache');

    // Create ZIP archive and pipe to response
    const archive = archiver('zip', {
      zlib: { level: 6 } // Compression level
    });

    // Handle archive events
    archive.on('error', (err) => {
      this.logger.error(`Error creating ZIP for order ${orderId}:`, err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Error creating ZIP file' });
      }
    });

    archive.on('warning', (err) => {
      if (err.code === 'ENOENT') {
        this.logger.warn(`ZIP warning for order ${orderId}:`, err);
      } else {
        this.logger.error(`ZIP error for order ${orderId}:`, err);
      }
    });

    // Pipe archive to response
    archive.pipe(res);

    let appendedCount = 0;
    let sourceBytes = 0;
    try {
      // Add each photo to the ZIP
      for (let i = 0; i < photos.length; i++) {
        const item = photos[i];
        const photo = item.photo!;

        try {
          this.logger.log(`Adding photo ${i + 1}/${photos.length} to ZIP: ${photo.id}`);

          // Get photo buffer from storage
          const photoBuffer = await this.getPhotoBuffer(photo.cloudinaryId);
          sourceBytes += photoBuffer.length;
          if (sourceBytes > 1_000_000_000) {
            throw new Error('El pedido excede el tamaño máximo permitido para un ZIP');
          }

          // Generate filename: photo_001.jpg, photo_002.jpg, etc.
          const filename = `photo_${(i + 1).toString().padStart(3, '0')}.jpg`;

          // Add to archive
          archive.append(photoBuffer, { name: filename });
          appendedCount += 1;

        } catch (photoError) {
          this.logger.error(`Error adding photo ${photo.id} to ZIP:`, photoError);
          // Continue with other photos instead of failing completely
        }
      }

      // Finalize the archive
      await archive.finalize();

      if (appendedCount > 0) {
        await this.recordPaidDownloadMetric(order, 'zip', appendedCount);
      }

      this.logger.log(`ZIP download completed for order ${orderId} with ${appendedCount} photos`);

    } catch (error) {
      this.logger.error(`Error creating ZIP for order ${orderId}:`, error);

      // If headers not sent yet, send error response
      if (!res.headersSent) {
        res.status(500).json({
          error: 'Error creating ZIP file',
          code: ERROR_CODES.DOWNLOAD_FAILED,
        });
      }
    }
  }

  private async getPhotoBuffer(cloudinaryId: string): Promise<Buffer> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const downloadUrl = await this.storageService.generateSecureDownloadUrl(cloudinaryId, 900);

      const response = await fetch(downloadUrl, { signal: controller.signal });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const declaredSize = Number(response.headers.get('content-length') || 0);
      if (declaredSize > 30_000_000) throw new Error('La foto excede el límite de descarga');
      if (!response.body) throw new Error('El almacenamiento devolvió una respuesta vacía');

      const reader = response.body.getReader();
      const chunks: Buffer[] = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > 30_000_000) {
          await reader.cancel();
          throw new Error('La foto excede el límite de descarga');
        }
        chunks.push(Buffer.from(value));
      }
      return Buffer.concat(chunks, total);

    } catch (error) {
      this.logger.error(`Error downloading photo ${cloudinaryId}`);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private assertOrderAccess(
    order: {
      id: string;
      status: string;
      userId: string | null;
      accessTokenHash: string | null;
      accessTokenExpiresAt: Date | null;
    },
    userId?: string,
    accessToken?: string,
  ) {
    if (userId && order.userId === userId) return;
    if (
      accessToken &&
      order.accessTokenHash &&
      order.accessTokenExpiresAt &&
      order.accessTokenExpiresAt.getTime() > Date.now() &&
      this.safeTokenHashMatches(accessToken, order.accessTokenHash)
    ) return;
    if (accessToken && order.status === 'PAID' && this.verifyPaidAccessToken(order.id, accessToken)) return;
    throw new ForbiddenException('No tienes acceso a este pedido');
  }

  private accessSecret() {
    const configured = this.configService.get('ORDER_ACCESS_SECRET') || this.configService.get('JWT_PRIVATE_KEY');
    if (configured) return configured;
    if (this.configService.get('NODE_ENV') === 'production') {
      throw new Error('ORDER_ACCESS_SECRET es obligatorio en producción');
    }
    return 'lucilamon-local-order-secret';
  }

  private createAccessToken(seed: string) {
    return createHmac('sha256', this.accessSecret()).update(`access:${seed}`).digest('hex');
  }

  private hashAccessToken(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }

  private safeTokenHashMatches(token: string, expectedHash: string) {
    const actual = Buffer.from(this.hashAccessToken(token), 'hex');
    const expected = Buffer.from(expectedHash, 'hex');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  private createPaidAccessToken(orderId: string) {
    const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
    const payload = Buffer.from(JSON.stringify({ orderId, expiresAt })).toString('base64url');
    const signature = createHmac('sha256', this.accessSecret()).update(`paid:${payload}`).digest('base64url');
    return `lm1.${payload}.${signature}`;
  }

  private verifyPaidAccessToken(orderId: string, token: string) {
    try {
      const [version, payload, providedSignature] = token.split('.');
      if (version !== 'lm1' || !payload || !providedSignature) return false;
      const expectedSignature = createHmac('sha256', this.accessSecret())
        .update(`paid:${payload}`)
        .digest('base64url');
      const expected = Buffer.from(expectedSignature);
      const provided = Buffer.from(providedSignature);
      if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) return false;
      const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      return decoded.orderId === orderId && Number(decoded.expiresAt) > Date.now();
    } catch {
      return false;
    }
  }

  private hashIdempotencyKey(value: string) {
    return createHmac('sha256', this.accessSecret()).update(`idempotency:${value}`).digest('hex');
  }

  private async getReplayRedirectUrl(gateway: string | null, paymentId: string | null) {
    if (gateway !== PaymentGateway.STRIPE || !paymentId) return undefined;
    try {
      const stripe = this.paymentGatewayFactory.createGateway(PaymentGateway.STRIPE) as StripeGatewayService;
      return await stripe.getOpenCheckoutUrl(paymentId);
    } catch {
      return undefined;
    }
  }

  private validateRedirectUrl(candidate: string | undefined, fallback: string) {
    if (!candidate) return fallback;
    const allowed = new Set<string>();
    const frontendUrl = this.configService.get('FRONTEND_URL');
    const corsOrigins = this.configService.get('CORS_ORIGINS');
    for (const value of [frontendUrl, ...(corsOrigins ? corsOrigins.split(',') : [])]) {
      if (!value) continue;
      try { allowed.add(new URL(value.trim()).origin); } catch { /* invalid configuration is ignored */ }
    }
    try {
      const parsed = new URL(candidate);
      return allowed.has(parsed.origin) ? parsed.toString() : fallback;
    } catch {
      return fallback;
    }
  }

  private async queueOrderConfirmation(orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        eventId: true,
        guestEmail: true,
        user: { select: { email: true } },
      },
    });
    const email = order?.user?.email || order?.guestEmail;
    if (!order?.eventId || !email) return;
    await this.queueService.addSendEmailJob(
      {
        kind: 'ORDER_CONFIRMATION',
        eventId: order.eventId,
        bib: '',
        email,
        orderId: order.id,
        downloadToken: this.createPaidAccessToken(order.id),
      },
      0,
      `order-confirmation-${order.id}`,
    );
  }

  private async markOrderPaid(orderId: string, paymentId: string) {
    const current = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { stripeSessionId: true, status: true, paymentGateway: true },
    });
    if (!current) throw new NotFoundException('Pedido no encontrado');
    if (current.status === 'REFUNDED') throw new BadRequestException('Un pedido reembolsado no puede volver a pagarse');
    if (current.status !== 'PAID') {
      await this.prisma.order.update({
        where: { id: orderId },
        data: {
          status: 'PAID',
          stripeSessionId: current.stripeSessionId || paymentId,
          paymentId,
          paidAt: new Date(),
        },
      });
    }
    await this.createLedgerForOrder(orderId);
    await this.recordPurchaseMetric(orderId);
    if (current.paymentGateway === PaymentGateway.STRIPE) {
      await this.settleStripeOrder(orderId);
    } else {
      await this.prisma.order.update({
        where: { id: orderId },
        data: { settlementStatus: 'NOT_REQUIRED', settlementError: null },
      });
    }
  }

  /**
   * Comisión que se quedó la pasarela en este cobro, según la propia pasarela.
   *
   * Se lee de la transacción de balance en lugar de estimarla con una fórmula:
   * el porcentaje de Stripe cambia por país, por tipo de tarjeta y por divisa,
   * y una fórmula aproximada dejaría el ledger descuadrado con el banco.
   *
   * Devuelve 0 cuando no se puede determinar. Es preferible a bloquear el
   * reparto: la venta ya ocurrió y el fotógrafo debe cobrar.
   */
  // ═══════════════════════════════════════════════════════════════════════
  // Contracargos
  //
  // Un reembolso lo decidimos nosotros; un contracargo lo decide el banco del
  // comprador y llega sin avisar. Si no se atiende, la pasarela retira el
  // importe y su comisión mientras la transferencia al fotógrafo sigue en pie:
  // se pierde el importe, la comisión y lo ya transferido.
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Abre el contracargo: recupera lo transferido, corta el acceso a la descarga
   * y envía a la pasarela la prueba de entrega que ya teníamos registrada.
   */
  async handleDisputeOpened(input: {
    disputeId: string;
    chargeId: string;
    amountCents: number;
    feeCents: number;
    reason?: string;
  }): Promise<void> {
    const order = await this.findOrderByCharge(input.chargeId);
    if (!order) {
      this.logger.warn(`Contracargo ${input.disputeId} sin pedido asociado (cargo ${input.chargeId})`);
      return;
    }
    if (order.stripeDisputeId === input.disputeId) return; // reintento del webhook

    this.logger.warn(
      `⚠️ Contracargo ${input.disputeId} sobre el pedido ${order.id}: ` +
      `${input.amountCents} céntimos, motivo "${input.reason || 'sin especificar'}"`,
    );

    // Primero se recupera lo del fotógrafo. Si se hiciera al final y algo
    // fallara, el importe ya estaría fuera y lo asumiría la plataforma.
    await this.reverseTransfersForOrder(order.id, `Contracargo ${input.disputeId}`);

    await this.prisma.order.update({
      where: { id: order.id },
      data: {
        status: 'DISPUTED',
        stripeDisputeId: input.disputeId,
        disputedAt: new Date(),
        disputeOutcome: 'needs_response',
        // Se invalida el acceso: el comprador ya reclamó su dinero.
        accessTokenHash: null,
        accessTokenExpiresAt: null,
      },
    });

    const entries: any[] = [
      {
        dedupeKey: `${order.id}:dispute:${input.disputeId}`,
        orderId: order.id,
        eventId: order.eventId,
        type: 'DISPUTE',
        status: 'AVAILABLE',
        amountCents: input.amountCents,
        currency: order.currency,
      },
    ];
    // La comisión de disputa no se devuelve aunque el caso se gane, así que se
    // anota como movimiento propio y no mezclada con el importe.
    if (input.feeCents > 0) {
      entries.push({
        dedupeKey: `${order.id}:dispute_fee:${input.disputeId}`,
        orderId: order.id,
        eventId: order.eventId,
        type: 'DISPUTE_FEE',
        status: 'AVAILABLE',
        amountCents: input.feeCents,
        currency: order.currency,
      });
    }
    await this.prisma.ledgerEntry.createMany({ data: entries, skipDuplicates: true });

    await this.submitDisputeEvidence(input.disputeId, order.id);
  }

  /** Refleja el desenlace para que el pedido no se quede en un estado ambiguo. */
  async handleDisputeClosed(disputeId: string, status: string): Promise<void> {
    const order = await this.prisma.order.findFirst({ where: { stripeDisputeId: disputeId } });
    if (!order) return;

    const won = status === 'won';
    await this.prisma.order.update({
      where: { id: order.id },
      data: {
        disputeOutcome: status,
        // Ganar devuelve el importe, así que el pedido vuelve a estar pagado.
        // Perder lo deja como reembolsado: el comprador se quedó su dinero.
        status: won ? 'PAID' : 'REFUNDED',
        ...(won ? {} : { refundedAt: new Date() }),
      },
    });
    this.logger.log(`Contracargo ${disputeId} cerrado como "${status}" en el pedido ${order.id}`);
  }

  /**
   * Envía la prueba de entrega. En bienes digitales lo que decide una disputa es
   * demostrar que el comprador recibió el archivo y que conocía la política.
   */
  private async submitDisputeEvidence(disputeId: string, orderId: string): Promise<void> {
    try {
      const stripeGateway = this.paymentGatewayFactory.createGateway(PaymentGateway.STRIPE) as StripeGatewayService;
      const stripe = stripeGateway.getStripeInstance();

      const order = await this.prisma.order.findUnique({
        where: { id: orderId },
        select: {
          createdAt: true,
          guestEmail: true,
          refundPolicyAcceptedAt: true,
          user: { select: { email: true } },
          event: { select: { name: true } },
          _count: { select: { items: true } },
        },
      });
      if (!order) return;

      const downloads = await this.prisma.metricEvent.findMany({
        where: { orderId, type: 'PAID_DOWNLOAD' },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true, source: true },
      });

      const buyer = order.user?.email || order.guestEmail || undefined;
      const activity = downloads.length
        ? downloads
            .map(d => `${d.createdAt.toISOString()} — descarga completada (${d.source || 'web'})`)
            .join('\n')
        : 'Sin descargas registradas para este pedido.';

      await stripe.disputes.update(disputeId, {
        evidence: {
          customer_email_address: buyer,
          product_description:
            `${order._count.items} fotografía(s) digital(es) del evento "${order.event?.name || ''}", ` +
            `entregadas por descarga inmediata tras el pago.`,
          service_date: order.createdAt.toISOString(),
          customer_purchase_ip: undefined,
          refund_policy_disclosure: order.refundPolicyAcceptedAt
            ? `El comprador aceptó expresamente la política de no devolución de archivos digitales el ${order.refundPolicyAcceptedAt.toISOString()}, antes de completar el pago.`
            : 'La política de no devolución de archivos digitales se muestra en el proceso de compra.',
          access_activity_log: activity,
          uncategorized_text:
            'Producto digital entregado de forma inmediata. El registro de descargas confirma la recepción por parte del comprador.',
        },
        // No se envía todavía: deja margen para añadir pruebas antes del plazo.
        submit: false,
      });

      this.logger.log(
        `Evidencia preparada para el contracargo ${disputeId} (${downloads.length} descarga(s) registradas)`,
      );
    } catch (error) {
      // La evidencia es importante pero no puede impedir que el contracargo
      // quede registrado y el dinero recuperado del fotógrafo.
      this.logger.error(
        `No se pudo preparar la evidencia del contracargo ${disputeId}: ${
          error instanceof Error ? error.message : 'error desconocido'
        }`,
      );
    }
  }

  private async findOrderByCharge(chargeId: string) {
    const direct = await this.prisma.order.findFirst({ where: { paymentId: chargeId } });
    if (direct) return direct;

    // El cargo no siempre se guarda: hay que remontar hasta la sesión.
    try {
      const stripeGateway = this.paymentGatewayFactory.createGateway(PaymentGateway.STRIPE) as StripeGatewayService;
      const stripe = stripeGateway.getStripeInstance();
      const charge = await stripe.charges.retrieve(chargeId);
      const intentId = typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id;
      if (!intentId) return null;
      const sessions = await stripe.checkout.sessions.list({ payment_intent: intentId, limit: 1 });
      const sessionId = sessions.data[0]?.id;
      if (!sessionId) return null;
      return this.prisma.order.findFirst({ where: { stripeSessionId: sessionId } });
    } catch {
      return null;
    }
  }

  /** Devuelve a la plataforma lo ya transferido a los beneficiarios. */
  private async reverseTransfersForOrder(orderId: string, reason: string): Promise<void> {
    const entries = await this.prisma.ledgerEntry.findMany({
      where: {
        orderId,
        type: { in: ['ORGANIZER_COMMISSION', 'PHOTOGRAPHER_EARNING'] },
        externalTransferId: { not: null },
      },
    });
    if (!entries.length) return;

    const stripeGateway = this.paymentGatewayFactory.createGateway(PaymentGateway.STRIPE) as StripeGatewayService;
    const stripe = stripeGateway.getStripeInstance();

    for (const entry of entries) {
      try {
        await stripe.transfers.createReversal(
          entry.externalTransferId!,
          { metadata: { orderId, motivo: reason } },
          { idempotencyKey: `lucilamon-dispute-reversal-${entry.id}` },
        );
        await this.prisma.ledgerEntry.update({
          where: { id: entry.id },
          data: { status: 'REVERSED', failureReason: reason },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Error revirtiendo transferencia';
        this.logger.error(`No se pudo revertir ${entry.externalTransferId} del pedido ${orderId}: ${message}`);
        await this.prisma.ledgerEntry.update({
          where: { id: entry.id },
          data: { failureReason: message.slice(0, 1000) },
        });
      }
    }
  }

  private async fetchProcessorFee(order: { id: string; paymentGateway: string | null; stripeSessionId: string | null }): Promise<number> {
    if (order.paymentGateway !== PaymentGateway.STRIPE || !order.stripeSessionId) return 0;

    try {
      const stripeGateway = this.paymentGatewayFactory.createGateway(PaymentGateway.STRIPE) as StripeGatewayService;
      const stripe = stripeGateway.getStripeInstance();
      const session = await stripe.checkout.sessions.retrieve(order.stripeSessionId, {
        expand: ['payment_intent.latest_charge.balance_transaction'],
      });
      const charge = (session.payment_intent as any)?.latest_charge;
      const balanceTransaction = typeof charge === 'string' ? null : charge?.balance_transaction;
      const fee = typeof balanceTransaction === 'string' ? null : balanceTransaction?.fee;

      if (typeof fee !== 'number') {
        this.logger.warn(`Stripe no devolvió la comisión del pedido ${order.id}; se reparte sin descontarla`);
        return 0;
      }
      this.logger.log(`Comisión de Stripe en el pedido ${order.id}: ${fee} céntimos`);
      return Math.max(0, fee);
    } catch (error) {
      this.logger.warn(
        `No se pudo leer la comisión de Stripe del pedido ${order.id}: ${
          error instanceof Error ? error.message : 'error desconocido'
        }`,
      );
      return 0;
    }
  }

  private async createLedgerForOrder(orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        event: {
          include: {
            workspace: { select: { id: true, ownerId: true } },
            contributors: {
              where: { status: 'ACCEPTED' },
              select: { photographerWorkspaceId: true, organizerCommissionPercent: true },
            },
          },
        },
        items: {
          include: { beneficiaryWorkspace: { select: { id: true, ownerId: true } } },
        },
      },
    });
    if (!order || !order.event) return;

    // Porcentaje heredado del evento. Solo se usa como red de seguridad cuando
    // el beneficiario no tiene plan resoluble (espacio borrado, seed sin correr).
    const fallbackPlatformPercent = Number(order.event.platformFeePercent || 0);
    const organizerWorkspace = order.event.workspace;
    const photographerEarnings = new Map<string, { amount: number; ownerId: string }>();
    let organizerCommission = 0;
    let platformFee = 0;

    // La comisión la fija el plan de cada beneficiario, así que dos fotógrafos
    // del mismo evento pueden pagar porcentajes distintos. Se resuelve una vez
    // por espacio para no consultar el plan en cada línea del pedido.
    // Comisión real de la pasarela. Se descuenta del bruto ANTES de repartir,
    // que es como quedó definido el modelo: la absorbe el fotógrafo, no la
    // plataforma. Sin esto el ledger no cuadraba con el banco, porque Stripe se
    // cobra lo suyo del cargo y aquí se repartía el importe completo.
    const processorFeeCents = await this.fetchProcessorFee(order);
    const grossCents = order.items.reduce((sum, item) => sum + item.priceCents, 0) || 1;
    let processorAssigned = 0;

    const percentByWorkspace = new Map<string, number>();
    for (const item of order.items) {
      const beneficiaryId = (item.beneficiaryWorkspace || organizerWorkspace)?.id;
      if (!beneficiaryId || percentByWorkspace.has(beneficiaryId)) continue;
      const planPercent = await this.billingService.commissionPercentFor(beneficiaryId);
      percentByWorkspace.set(beneficiaryId, planPercent ?? fallbackPlatformPercent);
    }

    for (const item of order.items) {
      const beneficiary = item.beneficiaryWorkspace || organizerWorkspace;
      if (!beneficiary) continue;
      const platformPercent = percentByWorkspace.get(beneficiary.id) ?? fallbackPlatformPercent;
      const platformShare = Math.round(item.priceCents * platformPercent / 100);
      // La última línea recoge el redondeo para que las partes sumen exactamente
      // lo que cobró Stripe, sin céntimos perdidos.
      const isLastItem = item === order.items[order.items.length - 1];
      const processorShare = isLastItem
        ? processorFeeCents - processorAssigned
        : Math.round((processorFeeCents * item.priceCents) / grossCents);
      processorAssigned += processorShare;
      platformFee += platformShare;
      const afterPlatform = Math.max(0, item.priceCents - platformShare - processorShare);
      const contributorTerms = order.event.contributors.find(c => c.photographerWorkspaceId === beneficiary.id);
      const organizerPercent = beneficiary.id === organizerWorkspace?.id
        ? 0
        : Number(contributorTerms?.organizerCommissionPercent ?? order.event.organizerCommissionPercent ?? 0);
      const organizerShare = Math.round(afterPlatform * organizerPercent / 100);
      organizerCommission += organizerShare;
      const earning = Math.max(0, afterPlatform - organizerShare);
      const current = photographerEarnings.get(beneficiary.id) || { amount: 0, ownerId: beneficiary.ownerId };
      current.amount += earning;
      photographerEarnings.set(beneficiary.id, current);
    }

    const entries: any[] = [
      {
        dedupeKey: `${orderId}:gross:${organizerWorkspace?.id || 'platform'}`,
        orderId,
        eventId: order.eventId,
        workspaceId: organizerWorkspace?.id,
        beneficiaryUserId: organizerWorkspace?.ownerId,
        type: 'GROSS_SALE',
        status: 'AVAILABLE',
        amountCents: order.amountCents,
        currency: order.currency,
      },
      ...(processorFeeCents > 0
        ? [{
            dedupeKey: `${orderId}:processor_fee:platform`,
            orderId,
            eventId: order.eventId,
            type: 'PROCESSOR_FEE',
            status: 'AVAILABLE',
            amountCents: processorFeeCents,
            currency: order.currency,
          }]
        : []),
      {
        dedupeKey: `${orderId}:platform_fee:platform`,
        orderId,
        eventId: order.eventId,
        type: 'PLATFORM_FEE',
        status: 'AVAILABLE',
        amountCents: platformFee,
        currency: order.currency,
      },
    ];

    if (organizerCommission > 0 && organizerWorkspace) {
      entries.push({
        dedupeKey: `${orderId}:organizer_commission:${organizerWorkspace.id}`,
        orderId,
        eventId: order.eventId,
        workspaceId: organizerWorkspace.id,
        beneficiaryUserId: organizerWorkspace.ownerId,
        type: 'ORGANIZER_COMMISSION',
        status: 'AVAILABLE',
        amountCents: organizerCommission,
        currency: order.currency,
      });
    }

    for (const [workspaceId, earning] of photographerEarnings) {
      entries.push({
        dedupeKey: `${orderId}:photographer_earning:${workspaceId}`,
        orderId,
        eventId: order.eventId,
        workspaceId,
        beneficiaryUserId: earning.ownerId,
        type: 'PHOTOGRAPHER_EARNING',
        status: 'AVAILABLE',
        amountCents: earning.amount,
        currency: order.currency,
      });
    }

    await this.prisma.ledgerEntry.createMany({ data: entries, skipDuplicates: true });
  }

  async retrySettlements(userId: string, userRole: UserRole) {
    return this.sweepPendingSettlements(userRole === UserRole.ADMIN ? undefined : userId);
  }

  /**
   * Reintenta las liquidaciones que quedaron sin transferir.
   *
   * Una venta no se bloquea porque el fotógrafo aún no haya terminado su alta
   * en Stripe: se cobra y el asiento espera. Este barrido es lo que hace que
   * ese dinero acabe llegando en lugar de quedarse quieto para siempre.
   *
   * Sin `beneficiaryUserId` recorre todos los pendientes, que es como lo usa
   * el cron.
   */
  async sweepPendingSettlements(beneficiaryUserId?: string) {
    const pending = await this.prisma.ledgerEntry.findMany({
      where: {
        status: 'AVAILABLE',
        type: { in: ['ORGANIZER_COMMISSION', 'PHOTOGRAPHER_EARNING'] },
        ...(beneficiaryUserId ? { beneficiaryUserId } : {}),
        order: { status: 'PAID', paymentGateway: PaymentGateway.STRIPE, refundRequestedAt: null },
      },
      select: { orderId: true },
      distinct: ['orderId'],
      take: 50,
      orderBy: { createdAt: 'asc' },
    });
    const settled: string[] = [];
    const failed: Array<{ orderId: string; error: string }> = [];
    for (const { orderId } of pending) {
      try {
        await this.settleStripeOrder(orderId);
        settled.push(orderId);
      } catch (error) {
        failed.push({ orderId, error: error instanceof Error ? error.message : 'Error desconocido' });
      }
    }
    return { attempted: pending.length, settled, failed };
  }

  async refundOrder(orderId: string, reason: string | undefined, adminUserId: string, userRole: UserRole) {
    if (userRole !== UserRole.ADMIN) throw new ForbiddenException('Solo administradores pueden reembolsar pedidos');
    const existing = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!existing) throw new NotFoundException('Pedido no encontrado');
    if (existing.status === 'REFUNDED') {
      return { orderId, status: existing.status, refundId: existing.stripeRefundId, idempotentReplay: true };
    }
    if (existing.status !== 'PAID' || existing.paymentGateway !== PaymentGateway.STRIPE || !existing.stripeSessionId) {
      throw new BadRequestException('Solo se pueden reembolsar pedidos de Stripe confirmados');
    }

    const stale = new Date(Date.now() - 10 * 60_000);
    const claim = await this.prisma.order.updateMany({
      where: {
        id: orderId,
        status: 'PAID',
        OR: [
          { refundRequestedAt: null, settlementStatus: { not: 'PROCESSING' } },
          { refundRequestedAt: { not: null }, settlementStatus: 'FAILED', updatedAt: { lt: stale } },
        ],
      },
      data: {
        refundRequestedAt: existing.refundRequestedAt || new Date(),
        refundError: null,
        settlementStatus: 'PROCESSING',
        settlementError: null,
      },
    });
    if (claim.count === 0) throw new BadRequestException('El pedido tiene una liquidación o reembolso en curso');

    try {
      const stripeGateway = this.paymentGatewayFactory.createGateway(PaymentGateway.STRIPE) as StripeGatewayService;
      const stripe = stripeGateway.getStripeInstance();
      const paidEntries = await this.prisma.ledgerEntry.findMany({
        where: { orderId, status: 'PAID_OUT' },
        orderBy: { createdAt: 'desc' },
      });
      for (const entry of paidEntries) {
        if (!entry.externalTransferId) throw new Error(`La liquidación ${entry.id} no tiene transferencia asociada`);
        const reversal = entry.externalReversalId
          ? { id: entry.externalReversalId }
          : await stripe.transfers.createReversal(
              entry.externalTransferId,
              { metadata: { orderId, ledgerEntryId: entry.id } },
              { idempotencyKey: `lucilamon-reversal-${entry.id}` },
            );
        await this.prisma.ledgerEntry.update({
          where: { id: entry.id },
          data: {
            status: 'REVERSED',
            externalReversalId: reversal.id,
            failureReason: null,
          },
        });
      }

      const session = await stripe.checkout.sessions.retrieve(existing.stripeSessionId, {
        expand: ['payment_intent'],
      });
      const paymentIntentId = typeof session.payment_intent === 'string'
        ? session.payment_intent
        : session.payment_intent?.id;
      if (!paymentIntentId) throw new Error('No se encontró el PaymentIntent del pedido');
      const refund = existing.stripeRefundId
        ? { id: existing.stripeRefundId }
        : await stripe.refunds.create({
            payment_intent: paymentIntentId,
            reason: 'requested_by_customer',
            metadata: { orderId, adminUserId, reason: reason || 'Sin motivo indicado' },
          }, { idempotencyKey: `lucilamon-refund-${orderId}` });

      await this.prisma.$transaction(async tx => {
        await tx.ledgerEntry.updateMany({
          where: { orderId, status: { not: 'REVERSED' } },
          data: { status: 'REVERSED' },
        });
        await tx.ledgerEntry.createMany({
          data: [{
            dedupeKey: `${orderId}:refund:${refund.id}`,
            orderId,
            eventId: existing.eventId,
            type: 'REFUND',
            status: 'AVAILABLE',
            amountCents: -existing.amountCents,
            currency: existing.currency,
            metadata: { stripeRefundId: refund.id, reason: reason || null },
          }],
          skipDuplicates: true,
        });
        await tx.order.update({
          where: { id: orderId },
          data: {
            status: 'REFUNDED',
            refundedAt: new Date(),
            stripeRefundId: refund.id,
            refundError: null,
            settlementStatus: 'NOT_REQUIRED',
            settlementError: null,
          },
        });
        await tx.auditLog.create({
          data: {
            userId: adminUserId,
            action: 'ORDER_REFUNDED',
            data: { orderId, stripeRefundId: refund.id, reason: reason || null },
          },
        });
      });

      return { orderId, status: 'REFUNDED', refundId: refund.id };
    } catch (error) {
      const message = (error instanceof Error ? error.message : 'Error procesando el reembolso').slice(0, 1000);
      await this.prisma.order.update({
        where: { id: orderId },
        data: { settlementStatus: 'FAILED', settlementError: message, refundError: message },
      });
      throw error;
    }
  }

  /**
   * El lote completo tiene que serlo de verdad: o todas las fotografías de un
   * dorsal, o todas las del evento. Cualquier otra cosa es comprar sueltas al
   * precio del lote.
   */
  private async assertCoversWholeSet(eventId: string, photoIds: string[]): Promise<void> {
    const selected = new Set(photoIds);

    // Caso 1: son todas las del evento.
    const eventTotal = await this.prisma.photo.count({
      where: { eventId, status: 'PROCESSED', publicationStatus: 'APPROVED' },
    });
    if (eventTotal > 0 && selected.size === eventTotal) return;

    // Caso 2: son todas las de algún dorsal presente en la selección. Se busca
    // entre los dorsales de las fotografías elegidas, no entre todos los del
    // evento, para no recorrer una carrera entera por cada pedido.
    const bibs = await this.prisma.photoBib.findMany({
      where: { eventId, photoId: { in: photoIds } },
      select: { bib: true },
      distinct: ['bib'],
      take: 20,
    });

    for (const { bib } of bibs) {
      const forBib = await this.prisma.photoBib.findMany({
        where: {
          bib,
          eventId,
          photo: { status: 'PROCESSED', publicationStatus: 'APPROVED' },
        },
        select: { photoId: true },
        distinct: ['photoId'],
      });
      if (forBib.length === 0) continue;
      const covered = forBib.every(entry => selected.has(entry.photoId));
      if (covered && forBib.length === selected.size) return;
    }

    throw new BadRequestException({
      code: 'PACKAGE_NOT_COMPLETE',
      message:
        'El precio de "todas las fotografías" solo se aplica al conjunto completo de un dorsal o del evento. Selecciona todas o compra por unidad.',
    });
  }

  private async settleStripeOrder(orderId: string) {
    const staleProcessing = new Date(Date.now() - 10 * 60_000);
    const claim = await this.prisma.order.updateMany({
      where: {
        id: orderId,
        status: 'PAID',
        paymentGateway: PaymentGateway.STRIPE,
        refundRequestedAt: null,
        OR: [
          { settlementStatus: { in: ['PENDING', 'PARTIAL', 'FAILED'] } },
          { settlementStatus: 'PROCESSING', updatedAt: { lt: staleProcessing } },
        ],
      },
      data: { settlementStatus: 'PROCESSING', settlementError: null },
    });
    if (claim.count === 0) return;

    try {
      const order = await this.prisma.order.findUnique({
        where: { id: orderId },
        include: {
          ledgerEntries: {
            where: {
              status: 'AVAILABLE',
              type: { in: ['ORGANIZER_COMMISSION', 'PHOTOGRAPHER_EARNING'] },
              amountCents: { gt: 0 },
            },
            include: {
              workspace: {
                select: {
                  id: true,
                  owner: {
                    select: {
                      stripeAccountId: true,
                      stripeOnboardingCompleted: true,
                      stripeChargesEnabled: true,
                      stripePayoutsEnabled: true,
                    },
                  },
                },
              },
            },
          },
        },
      });
      if (!order?.stripeSessionId) throw new Error('El pedido no tiene una sesión Stripe asociada');
      if (order.ledgerEntries.length === 0) {
        await this.prisma.order.update({
          where: { id: orderId },
          data: { settlementStatus: 'SETTLED', settledAt: new Date(), settlementError: null },
        });
        return;
      }

      const stripeGateway = this.paymentGatewayFactory.createGateway(PaymentGateway.STRIPE) as StripeGatewayService;
      const stripe = stripeGateway.getStripeInstance();
      const session = await stripe.checkout.sessions.retrieve(order.stripeSessionId, {
        expand: ['payment_intent.latest_charge'],
      });
      const paymentIntent = session.payment_intent as any;
      const latestCharge = paymentIntent?.latest_charge;
      const sourceTransaction = typeof latestCharge === 'string' ? latestCharge : latestCharge?.id;
      if (!sourceTransaction) throw new Error('Stripe no devolvió el cargo origen para distribuir la venta');

      const unavailable: string[] = [];
      for (const entry of order.ledgerEntries) {
        const recipient = entry.workspace?.owner;
        if (
          !recipient?.stripeAccountId
          || !recipient.stripeOnboardingCompleted
          || !recipient.stripeChargesEnabled
          || !recipient.stripePayoutsEnabled
        ) {
          // Dos mensajes distintos a propósito. El del pedido lo leemos
          // nosotros para diagnosticar, así que lleva el identificador. El del
          // asiento lo lee el fotógrafo en su facturación: un UUID interno no
          // le dice nada ni le indica qué tiene que hacer.
          unavailable.push(`El espacio ${entry.workspaceId || 'desconocido'} todavía no tiene Stripe Connect habilitado`);
          await this.prisma.ledgerEntry.update({
            where: { id: entry.id },
            data: { failureReason: 'Falta completar tu alta de cobros para poder transferirte.' },
          });
          continue;
        }

        try {
          const transfer = await stripe.transfers.create({
            amount: entry.amountCents,
            currency: entry.currency.toLowerCase(),
            destination: recipient.stripeAccountId,
            source_transaction: sourceTransaction,
            transfer_group: order.stripeTransferGroup || `lucilamon_order_${order.id}`,
            metadata: {
              orderId: order.id,
              ledgerEntryId: entry.id,
              workspaceId: entry.workspaceId || '',
              type: entry.type,
            },
          }, { idempotencyKey: `lucilamon-ledger-${entry.id}` });
          await this.prisma.ledgerEntry.update({
            where: { id: entry.id },
            data: {
              status: 'PAID_OUT',
              externalTransferId: transfer.id,
              paidOutAt: new Date(),
              failureReason: null,
            },
          });
        } catch (error) {
          const reason = (error instanceof Error ? error.message : 'Error creando transferencia').slice(0, 1000);
          await this.prisma.ledgerEntry.update({
            where: { id: entry.id },
            data: { failureReason: reason },
          });
          throw error;
        }
      }

      await this.prisma.order.update({
        where: { id: orderId },
        data: unavailable.length > 0 ? {
          settlementStatus: 'PARTIAL',
          settlementError: unavailable.join('; ').slice(0, 1000),
          settledAt: null,
        } : {
          settlementStatus: 'SETTLED',
          settlementError: null,
          settledAt: new Date(),
        },
      });
    } catch (error) {
      const message = (error instanceof Error ? error.message : 'Error liquidando el pedido').slice(0, 1000);
      await this.prisma.order.update({
        where: { id: orderId },
        data: { settlementStatus: 'FAILED', settlementError: message, settledAt: null },
      });
      throw error;
    }
  }

  private async recordPurchaseMetric(orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { event: { select: { workspaceId: true } } },
    });
    if (!order) return;
    await this.prisma.metricEvent.createMany({
      data: [{
        dedupeKey: `purchase:${orderId}`,
        type: 'PURCHASE_COMPLETED',
        orderId,
        eventId: order.eventId,
        workspaceId: order.event?.workspaceId,
        userId: order.userId,
        metadata: { amountCents: order.amountCents, currency: order.currency },
      }],
      skipDuplicates: true,
    });
  }

  private async recordPaidDownloadMetric(
    order: {
      id: string;
      eventId: string | null;
      userId: string | null;
      event: { workspaceId: string | null } | null;
    },
    source: 'direct_urls' | 'zip',
    photoCount: number,
  ) {
    try {
      await this.prisma.metricEvent.create({
        data: {
          type: 'PAID_DOWNLOAD',
          orderId: order.id,
          eventId: order.eventId,
          workspaceId: order.event?.workspaceId,
          userId: order.userId,
          source,
          metadata: { photoCount },
        },
      });
    } catch {
      this.logger.warn(`No se pudo registrar la descarga pagada del pedido ${order.id}`);
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

  private isValidPricing(pricing: EventPricing) {
    return ['singlePhoto', 'pack5', 'pack10', 'allPhotos'].every(field => {
      const amount = pricing[field as keyof EventPricing];
      return typeof amount === 'number' && Number.isInteger(amount) && amount > 0 && amount <= 100_000_000;
    }) && typeof pricing.currency === 'string' && /^[A-Z]{3}$/.test(pricing.currency.toUpperCase());
  }
}
