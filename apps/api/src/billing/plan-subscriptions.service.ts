import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Plan, SubscriptionStatus } from '@prisma/client';
import Stripe from 'stripe';

import { PrismaService } from '../common/services/prisma.service';

/**
 * Ciclo de vida de la mensualidad del plan.
 *
 * Se apoya en suscripciones reales de Stripe en lugar de un cron propio: los
 * reintentos, los avisos de cobro fallido, las facturas y el prorrateo al
 * cambiar de plan ya están resueltos ahí y replicarlos saldría peor.
 *
 * El consumo variable del modo compartir NO va por aquí: se acumula por
 * fotografía y se liquida aparte en ShareBillingService, porque también lo
 * generan los espacios del plan gratuito, que no tienen suscripción en Stripe.
 */
/**
 * Código fiscal de Stripe: SaaS de uso comercial. Los planes van dirigidos a
 * fotógrafos profesionales, no a consumidores.
 *
 * Es obligatorio cuando la cuenta tiene Managed Payments activo —lo está por
 * defecto— y sin él Stripe rechaza el checkout entero.
 */
const SAAS_TAX_CODE = 'txcd_10103001';

@Injectable()
export class PlanSubscriptionsService {
  private readonly logger = new Logger(PlanSubscriptionsService.name);
  private readonly stripe: Stripe | null;
  private readonly demoPayments: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    const secretKey = this.config.get<string>('STRIPE_SECRET_KEY');
    this.stripe = secretKey ? new Stripe(secretKey, { apiVersion: '2022-11-15' }) : null;
    this.demoPayments = this.config.get('DEMO_PAYMENTS', 'false') === 'true';
  }

  /** Un plan sin mensualidad ni ampliaciones no necesita suscripción en Stripe. */
  private isBillable(plan: Plan, extraStorageBlocks: number): boolean {
    return plan.priceCents > 0 || (extraStorageBlocks > 0 && (plan.extraStorageBlockCents ?? 0) > 0);
  }

  /**
   * Deja la suscripción de Stripe en el estado que pide el plan elegido: la
   * crea, le cambia las líneas o la cancela. Devuelve los ids que hay que
   * guardar junto a la suscripción local.
   */
  async applyPlan(
    workspaceId: string,
    plan: Plan,
    extraStorageBlocks: number,
  ): Promise<{
    stripeSubscriptionId: string | null;
    stripePlanItemId: string | null;
    stripeStorageItemId: string | null;
    currentPeriodEnd: Date | null;
    status: SubscriptionStatus;
  }> {
    const existing = await this.prisma.subscription.findUnique({
      where: { workspaceId },
      select: { stripeSubscriptionId: true, stripePlanItemId: true, stripeStorageItemId: true },
    });

    const cleared = {
      stripeSubscriptionId: null,
      stripePlanItemId: null,
      stripeStorageItemId: null,
      currentPeriodEnd: null,
      status: SubscriptionStatus.ACTIVE,
    };

    if (!this.isBillable(plan, extraStorageBlocks)) {
      // Pasar al plan gratuito: se cancela de inmediato, sin esperar al fin del
      // periodo. Quien baja de plan deja de tener las ventajas al momento, así
      // que cobrarle el resto del mes sería cobrar por algo que ya no usa.
      if (existing?.stripeSubscriptionId) await this.cancelInStripe(existing.stripeSubscriptionId);
      return cleared;
    }

    if (this.demoPayments || !this.stripe) {
      this.logger.warn(
        `Sin pasarela activa: ${plan.name} se asigna a ${workspaceId} sin crear la suscripción`,
      );
      return cleared;
    }

    if (!plan.stripePriceId) {
      throw new BadRequestException({
        code: 'PLAN_NOT_SYNCED',
        message: `El plan ${plan.name} todavía no tiene precio en la pasarela. Ejecuta la sincronización de planes.`,
      });
    }
    if (extraStorageBlocks > 0 && !plan.stripeStoragePriceId) {
      throw new BadRequestException({
        code: 'PLAN_NOT_SYNCED',
        message: `El plan ${plan.name} no tiene precio de almacenamiento en la pasarela. Ejecuta la sincronización de planes.`,
      });
    }

    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { stripeCustomerId: true, defaultPaymentMethodId: true },
    });
    if (!workspace?.stripeCustomerId || !workspace.defaultPaymentMethodId) {
      throw new BadRequestException({
        code: 'PAYMENT_METHOD_REQUIRED',
        message: `El plan ${plan.name} cuesta ${(plan.priceCents / 100).toFixed(
          2,
        )} $ al mes. Añade un método de pago para activarlo.`,
      });
    }

    const subscription = existing?.stripeSubscriptionId
      ? await this.updateSubscription(existing, plan, extraStorageBlocks)
      : await this.createSubscription(workspace.stripeCustomerId, workspace.defaultPaymentMethodId, plan, extraStorageBlocks);

    const planItem = subscription.items.data.find(item => item.price.id === plan.stripePriceId);
    const storageItem = subscription.items.data.find(item => item.price.id === plan.stripeStoragePriceId);

    return {
      stripeSubscriptionId: subscription.id,
      stripePlanItemId: planItem?.id ?? null,
      stripeStorageItemId: storageItem?.id ?? null,
      currentPeriodEnd: subscription.current_period_end
        ? new Date(subscription.current_period_end * 1000)
        : null,
      status: this.mapStatus(subscription.status),
    };
  }

  /**
   * Sesión de Checkout alojada por Stripe para contratar un plan.
   *
   * Se prefiere a pedir la tarjeta dentro del panel: el comprador ve el dominio
   * de Stripe, con su 3D Secure y sus métodos de pago locales, y nosotros no
   * tocamos ni un dato de tarjeta. Es también lo que la gente espera al pulsar
   * "contratar".
   */
  async createCheckout(
    workspaceId: string,
    plan: Plan,
    extraStorageBlocks: number,
    urls: { successUrl: string; cancelUrl: string },
  ): Promise<{ url: string }> {
    if (!this.stripe) {
      throw new BadRequestException({
        code: 'BILLING_NOT_CONFIGURED',
        message: 'La facturación no está configurada.',
      });
    }
    if (!plan.stripePriceId) {
      throw new BadRequestException({
        code: 'PLAN_NOT_SYNCED',
        message: `El plan ${plan.name} todavía no tiene precio en la pasarela.`,
      });
    }

    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { stripeCustomerId: true, contactEmail: true, owner: { select: { email: true } } },
    });
    if (!workspace) throw new NotFoundException('Espacio no encontrado');

    const items: Stripe.Checkout.SessionCreateParams.LineItem[] = [
      { price: plan.stripePriceId, quantity: 1 },
    ];
    if (extraStorageBlocks > 0 && plan.stripeStoragePriceId) {
      items.push({ price: plan.stripeStoragePriceId, quantity: extraStorageBlocks });
    }

    const params: Stripe.Checkout.SessionCreateParams = {
      mode: 'subscription',
      line_items: items,
      success_url: urls.successUrl,
      cancel_url: urls.cancelUrl,
      // Con cliente existente se reutiliza; si no, Stripe lo crea y lo
      // recuperamos del webhook. Así no se duplican clientes por espacio.
      ...(workspace.stripeCustomerId
        ? { customer: workspace.stripeCustomerId }
        : { customer_email: workspace.contactEmail || workspace.owner?.email || undefined }),
      // El identificador viaja en los metadatos porque el webhook llega sin
      // sesión de usuario y es lo único que ata el pago a un espacio.
      metadata: { workspaceId, planSlug: plan.slug, extraStorageBlocks: String(extraStorageBlocks) },
      subscription_data: {
        metadata: { workspaceId, planSlug: plan.slug },
      },
      allow_promotion_codes: true,
    };

    // Managed Payments viene activo por defecto en la cuenta y exige código
    // fiscal, pero no existe en la versión de API a la que está fijado el
    // proyecto (2022-11-15). Se desactiva por sesión en lugar de subir la
    // versión, que cambiaría el comportamiento de todos los cobros,
    // transferencias y disputas. La API lo acepta aunque los tipos no lo
    // declaren, de ahí el acceso sin tipar.
    (params as unknown as Record<string, unknown>).managed_payments = { enabled: false };

    const session = await this.stripe.checkout.sessions.create(params);

    if (!session.url) throw new BadRequestException('Stripe no devolvió la dirección de pago');
    this.logger.log(`Checkout de suscripción creado para ${workspaceId}: ${session.id}`);
    return { url: session.url };
  }

  private async createSubscription(
    customerId: string,
    paymentMethodId: string,
    plan: Plan,
    extraStorageBlocks: number,
  ): Promise<Stripe.Subscription> {
    const items: Stripe.SubscriptionCreateParams.Item[] = [{ price: plan.stripePriceId! }];
    if (extraStorageBlocks > 0) {
      items.push({ price: plan.stripeStoragePriceId!, quantity: extraStorageBlocks });
    }

    try {
      return await this.stripe!.subscriptions.create({
        customer: customerId,
        items,
        default_payment_method: paymentMethodId,
        // Sin esto una tarjeta rechazada dejaría la suscripción en `incomplete`
        // y el espacio se quedaría con el plan activo en local sin haber pagado.
        payment_behavior: 'error_if_incomplete',
        proration_behavior: 'create_prorations',
        expand: ['items'],
      }, {
        // Sin esto, dos peticiones a la vez —un doble clic, un reintento de
        // red— crearían DOS suscripciones y le cobrarían el plan dos veces.
        // La clave incluye el cliente y el plan: cambiar de plan es una
        // operación distinta y debe poder ocurrir.
        idempotencyKey: `lucilamon-sub-${customerId}-${plan.slug}-${extraStorageBlocks}`,
      });
    } catch (error) {
      throw this.asPaymentError(error, plan);
    }
  }

  private async updateSubscription(
    existing: { stripeSubscriptionId: string | null; stripePlanItemId: string | null; stripeStorageItemId: string | null },
    plan: Plan,
    extraStorageBlocks: number,
  ): Promise<Stripe.Subscription> {
    const items: Stripe.SubscriptionUpdateParams.Item[] = [];

    if (existing.stripePlanItemId) {
      items.push({ id: existing.stripePlanItemId, price: plan.stripePriceId! });
    } else {
      items.push({ price: plan.stripePriceId! });
    }

    if (extraStorageBlocks > 0) {
      items.push(
        existing.stripeStorageItemId
          ? { id: existing.stripeStorageItemId, price: plan.stripeStoragePriceId!, quantity: extraStorageBlocks }
          : { price: plan.stripeStoragePriceId!, quantity: extraStorageBlocks },
      );
    } else if (existing.stripeStorageItemId) {
      // Quitar la ampliación: se borra la línea, no se pone a cantidad cero.
      items.push({ id: existing.stripeStorageItemId, deleted: true });
    }

    try {
      return await this.stripe!.subscriptions.update(existing.stripeSubscriptionId!, {
        items,
        proration_behavior: 'create_prorations',
        payment_behavior: 'error_if_incomplete',
        expand: ['items'],
      });
    } catch (error) {
      throw this.asPaymentError(error, plan);
    }
  }

  private async cancelInStripe(subscriptionId: string): Promise<void> {
    if (!this.stripe) return;
    try {
      await this.stripe.subscriptions.del(subscriptionId);
      this.logger.log(`Suscripción cancelada en Stripe: ${subscriptionId}`);
    } catch (error) {
      // Ya cancelada o inexistente: el estado que queremos es justo ese.
      this.logger.warn(
        `No se pudo cancelar ${subscriptionId}: ${error instanceof Error ? error.message : 'desconocido'}`,
      );
    }
  }

  private asPaymentError(error: unknown, plan: Plan): BadRequestException {
    const reason = error instanceof Error ? error.message : 'Error desconocido';
    this.logger.error(`Fallo al activar ${plan.slug}: ${reason}`);
    return new BadRequestException({
      code: 'SUBSCRIPTION_CHARGE_FAILED',
      message: `No se pudo cobrar el plan ${plan.name}. Revisa tu método de pago e inténtalo de nuevo.`,
      details: reason,
    });
  }

  private mapStatus(status: Stripe.Subscription.Status): SubscriptionStatus {
    if (status === 'active' || status === 'trialing') return SubscriptionStatus.ACTIVE;
    if (status === 'canceled' || status === 'incomplete_expired') return SubscriptionStatus.CANCELED;
    return SubscriptionStatus.PAST_DUE;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Webhooks
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Stripe confirmó el pago del checkout: ahora sí se concede el plan.
   *
   * Es el único punto donde un plan de pago pasa a estar activo. Hacerlo antes
   * —al pulsar contratar— regalaría el plan a quien abandona el formulario.
   */
  async applyPaidCheckout(session: Stripe.Checkout.Session): Promise<void> {
    const workspaceId = session.metadata?.workspaceId;
    const planSlug = session.metadata?.planSlug;
    if (!workspaceId || !planSlug) {
      this.logger.warn(`Checkout ${session.id} sin workspaceId o planSlug en metadatos`);
      return;
    }

    const plan = await this.prisma.plan.findUnique({ where: { slug: planSlug } });
    if (!plan) {
      this.logger.error(`Checkout ${session.id} apunta a un plan inexistente: ${planSlug}`);
      return;
    }

    const subscriptionId =
      typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;
    const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;
    const extraStorageBlocks = Number(session.metadata?.extraStorageBlocks || 0);

    // El cliente que creó Stripe se guarda para reutilizarlo en cobros futuros
    // —consumo del modo gratuito, cambios de plan— sin duplicarlo.
    if (customerId) {
      await this.prisma.workspace.updateMany({
        where: { id: workspaceId, stripeCustomerId: null },
        data: { stripeCustomerId: customerId },
      });
    }

    let planItemId: string | null = null;
    let storageItemId: string | null = null;
    let currentPeriodEnd: Date | null = null;

    if (subscriptionId && this.stripe) {
      const subscription = await this.stripe.subscriptions.retrieve(subscriptionId, { expand: ['items'] });
      planItemId = subscription.items.data.find(item => item.price.id === plan.stripePriceId)?.id ?? null;
      storageItemId = subscription.items.data.find(item => item.price.id === plan.stripeStoragePriceId)?.id ?? null;
      currentPeriodEnd = subscription.current_period_end
        ? new Date(subscription.current_period_end * 1000)
        : null;
    }

    await this.prisma.subscription.upsert({
      where: { workspaceId },
      create: {
        workspaceId,
        planId: plan.id,
        status: SubscriptionStatus.ACTIVE,
        extraStorageBlocks,
        stripeSubscriptionId: subscriptionId ?? null,
        stripeCustomerId: customerId ?? null,
        stripePlanItemId: planItemId,
        stripeStorageItemId: storageItemId,
        currentPeriodEnd,
      },
      update: {
        planId: plan.id,
        status: SubscriptionStatus.ACTIVE,
        extraStorageBlocks,
        cancelAtPeriodEnd: false,
        stripeSubscriptionId: subscriptionId ?? null,
        stripeCustomerId: customerId ?? null,
        stripePlanItemId: planItemId,
        stripeStorageItemId: storageItemId,
        currentPeriodEnd,
      },
    });

    this.logger.log(`Plan ${plan.name} activado en ${workspaceId} tras el checkout ${session.id}`);
  }

  /** Sincroniza estado y fin de periodo con lo que dice Stripe. */
  async syncFromStripe(subscription: Stripe.Subscription): Promise<void> {
    const local = await this.prisma.subscription.findUnique({
      where: { stripeSubscriptionId: subscription.id },
      select: { id: true, workspaceId: true },
    });
    if (!local) return;

    await this.prisma.subscription.update({
      where: { id: local.id },
      data: {
        status: this.mapStatus(subscription.status),
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
        currentPeriodEnd: subscription.current_period_end
          ? new Date(subscription.current_period_end * 1000)
          : null,
      },
    });
  }

  /**
   * Stripe agotó los reintentos y canceló la suscripción. El espacio baja al
   * plan gratuito: sube su comisión por venta y pierde las ventajas del plan,
   * pero su landing sigue en pie y sus fotografías intactas. Cortar el servicio
   * dejaría de generar ventas, que es de donde sale la comisión.
   */
  async downgradeToFreePlan(stripeSubscriptionId: string): Promise<void> {
    const local = await this.prisma.subscription.findUnique({
      where: { stripeSubscriptionId },
      select: { id: true, workspaceId: true, planId: true },
    });
    if (!local) return;

    const freePlan = await this.prisma.plan.findFirst({
      where: { isDefault: true, isActive: true },
    });
    if (!freePlan) {
      this.logger.error(
        `No hay plan gratuito configurado: ${local.workspaceId} se queda en PAST_DUE`,
      );
      await this.prisma.subscription.update({
        where: { id: local.id },
        data: { status: SubscriptionStatus.PAST_DUE },
      });
      return;
    }

    // A diferencia de un cambio voluntario, aquí no se comprueba el cupo: el
    // espacio puede quedar por encima del gratuito. No se borra nada; las
    // subidas nuevas se bloquearán solas hasta que libere espacio o pague.
    await this.prisma.subscription.update({
      where: { id: local.id },
      data: {
        planId: freePlan.id,
        status: SubscriptionStatus.ACTIVE,
        extraStorageBlocks: 0,
        stripeSubscriptionId: null,
        stripePlanItemId: null,
        stripeStorageItemId: null,
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
      },
    });
    this.logger.warn(
      `Impago agotado: ${local.workspaceId} baja al plan ${freePlan.name}`,
    );
  }

  async markPastDue(stripeSubscriptionId: string): Promise<void> {
    const local = await this.prisma.subscription.findUnique({
      where: { stripeSubscriptionId },
      select: { id: true, workspaceId: true },
    });
    if (!local) return;
    await this.prisma.subscription.update({
      where: { id: local.id },
      data: { status: SubscriptionStatus.PAST_DUE },
    });
    this.logger.warn(`Cobro fallido en ${local.workspaceId}: suscripción en PAST_DUE`);
  }

  async markActive(stripeSubscriptionId: string, periodEnd: number | null): Promise<void> {
    const local = await this.prisma.subscription.findUnique({
      where: { stripeSubscriptionId },
      select: { id: true },
    });
    if (!local) return;
    await this.prisma.subscription.update({
      where: { id: local.id },
      data: {
        status: SubscriptionStatus.ACTIVE,
        currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000) : undefined,
      },
    });
  }

  /**
   * Busca en Stripe suscripciones activas que aquí no constan y las registra.
   *
   * Es la red para el peor caso del cobro: alguien paga, Stripe cobra, y el
   * webhook no llega —el túnel caducó, la API estaba caída, la firma falló—.
   * Sin esto se queda pagando sin plan y nadie se entera hasta que reclama.
   *
   * Solo mira suscripciones que llevan nuestros metadatos, así que no toca
   * nada ajeno aunque la cuenta de Stripe se comparta.
   */
  async reconcileSubscriptions(): Promise<{ checked: number; repaired: string[] }> {
    if (!this.stripe) return { checked: 0, repaired: [] };

    const active = await this.stripe.subscriptions.list({
      status: 'active',
      limit: 100,
      expand: ['data.items'],
    });

    const repaired: string[] = [];
    for (const subscription of active.data) {
      const workspaceId = subscription.metadata?.workspaceId;
      const planSlug = subscription.metadata?.planSlug;
      if (!workspaceId || !planSlug) continue;

      const local = await this.prisma.subscription.findUnique({
        where: { workspaceId },
        select: { stripeSubscriptionId: true },
      });
      if (local?.stripeSubscriptionId === subscription.id) continue;

      // Otra suscripción viva para el mismo espacio significa que se creó por
      // duplicado. Se conserva la registrada y se cancela la huérfana, o el
      // fotógrafo pagaría dos veces cada mes.
      if (local?.stripeSubscriptionId) {
        this.logger.error(
          `${workspaceId} tiene dos suscripciones activas: ${local.stripeSubscriptionId} y ${subscription.id}. Se cancela la segunda.`,
        );
        await this.cancelInStripe(subscription.id);
        repaired.push(`${workspaceId}: duplicada cancelada`);
        continue;
      }

      const plan = await this.prisma.plan.findUnique({ where: { slug: planSlug } });
      if (!plan) continue;

      const customerId =
        typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id;

      await this.prisma.subscription.upsert({
        where: { workspaceId },
        create: {
          workspaceId,
          planId: plan.id,
          status: SubscriptionStatus.ACTIVE,
          extraStorageBlocks: Number(subscription.metadata?.extraStorageBlocks || 0),
          stripeSubscriptionId: subscription.id,
          stripeCustomerId: customerId ?? null,
          stripePlanItemId: subscription.items.data.find(i => i.price.id === plan.stripePriceId)?.id ?? null,
          stripeStorageItemId:
            subscription.items.data.find(i => i.price.id === plan.stripeStoragePriceId)?.id ?? null,
          currentPeriodEnd: subscription.current_period_end
            ? new Date(subscription.current_period_end * 1000)
            : null,
        },
        update: {
          planId: plan.id,
          status: SubscriptionStatus.ACTIVE,
          stripeSubscriptionId: subscription.id,
          stripeCustomerId: customerId ?? null,
        },
      });

      this.logger.warn(
        `Recuperada: ${workspaceId} pagaba ${plan.name} en Stripe y aquí no constaba (${subscription.id})`,
      );
      repaired.push(`${workspaceId}: ${plan.name} registrado`);
    }

    return { checked: active.data.length, repaired };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Sincronización del catálogo
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Crea en Stripe el producto y los precios de cada plan de pago y guarda sus
   * ids. Es idempotente: un plan que ya tiene precio se deja como está, porque
   * cambiar el importe de un precio en uso alteraría lo que ya se cobra.
   */
  async syncPlanPrices(): Promise<{ synced: string[]; skipped: string[] }> {
    if (!this.stripe) throw new BadRequestException('La facturación no está configurada');

    const plans = await this.prisma.plan.findMany({ where: { isActive: true } });
    const synced: string[] = [];
    const skipped: string[] = [];

    for (const plan of plans) {
      const needsPlanPrice = plan.priceCents > 0 && !plan.stripePriceId;
      const needsStoragePrice =
        (plan.extraStorageBlockCents ?? 0) > 0 && !plan.stripeStoragePriceId;

      if (!needsPlanPrice && !needsStoragePrice) {
        skipped.push(plan.slug);
        continue;
      }

      const product = await this.stripe.products.create({
        name: `LucilaMon · ${plan.name}`,
        description: plan.description ?? undefined,
        tax_code: SAAS_TAX_CODE,
        metadata: { planSlug: plan.slug },
      });

      const data: { stripePriceId?: string; stripeStoragePriceId?: string } = {};

      if (needsPlanPrice) {
        const price = await this.stripe.prices.create({
          product: product.id,
          currency: plan.currency.toLowerCase(),
          unit_amount: plan.priceCents,
          recurring: { interval: 'month' },
          metadata: { planSlug: plan.slug, kind: 'plan' },
        });
        data.stripePriceId = price.id;
      }

      if (needsStoragePrice) {
        const price = await this.stripe.prices.create({
          product: product.id,
          currency: plan.currency.toLowerCase(),
          unit_amount: plan.extraStorageBlockCents!,
          recurring: { interval: 'month' },
          metadata: { planSlug: plan.slug, kind: 'storage' },
        });
        data.stripeStoragePriceId = price.id;
      }

      await this.prisma.plan.update({ where: { id: plan.id }, data });
      synced.push(plan.slug);
      this.logger.log(`Plan ${plan.slug} sincronizado con Stripe`);
    }

    return { synced, skipped };
  }
}
