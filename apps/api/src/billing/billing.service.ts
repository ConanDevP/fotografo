import {
  BadRequestException,
  ForbiddenException,
  forwardRef,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Plan, PlanAudience, Prisma, Subscription, WorkspaceRole } from '@prisma/client';
import Stripe from 'stripe';

import { PrismaService } from '../common/services/prisma.service';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { PlanSubscriptionsService } from './plan-subscriptions.service';
import { UserRole } from '@shared/types';

export interface EffectivePlan {
  plan: Plan;
  subscription: Subscription | null;
  /// Almacenamiento total disponible: el del plan más los bloques contratados.
  storageAllowanceBytes: bigint;
  storageUsedBytes: bigint;
  storageAvailableBytes: bigint;
  commissionPercent: number;
}

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);
  /**
   * Nulo cuando no hay clave configurada. En ese caso la publicación en modo
   * compartir sigue funcionando sin cobrar, para no bloquear el desarrollo
   * local, y queda registrado en el log.
   */
  private readonly stripe: Stripe | null;
  private readonly demoPayments: boolean;

  constructor(
    private readonly prisma: PrismaService,
    // El otro extremo del ciclo con WorkspacesModule: sin forwardRef aquí, el
    // token no está resuelto todavía cuando Nest construye este servicio.
    @Inject(forwardRef(() => WorkspacesService))
    private readonly workspaces: WorkspacesService,
    private readonly config: ConfigService,
    private readonly planSubscriptions: PlanSubscriptionsService,
  ) {
    const secretKey = this.config.get<string>('STRIPE_SECRET_KEY');
    this.stripe = secretKey ? new Stripe(secretKey, { apiVersion: '2022-11-15' }) : null;
    this.demoPayments = this.config.get('DEMO_PAYMENTS', 'false') === 'true';
    if (this.demoPayments) {
      this.logger.warn('DEMO_PAYMENTS activo: el modo compartir no pasará ningún cobro');
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Catálogo
  // ───────────────────────────────────────────────────────────────────────────

  async listPlans(audience?: PlanAudience) {
    const plans = await this.prisma.plan.findMany({
      where: {
        isActive: true,
        ...(audience ? { audience: { in: [audience, PlanAudience.ANY] } } : {}),
      },
      orderBy: [{ sortOrder: 'asc' }, { priceCents: 'asc' }],
    });

    // Los tamaños son BigInt y JSON no sabe serializarlos: se emiten como texto
    // para no perder precisión ni romper la respuesta. Los Decimal se emiten
    // como número para que el cliente no tenga que convertirlos.
    return plans.map(({ stripePriceId, stripeStoragePriceId, ...plan }) => ({
      ...plan,
      commissionPercent: Number(plan.commissionPercent),
      sharePhotoCents: Number(plan.sharePhotoCents),
      includedStorageBytes: plan.includedStorageBytes.toString(),
      extraStorageBlockBytes: plan.extraStorageBlockBytes?.toString() ?? null,
    }));
  }

  /**
   * Plan al que cae un espacio sin suscripción explícita. Es el plan gratuito y
   * debe existir siempre: sin él no se puede calcular comisión ni cupo.
   */
  private async defaultPlan(): Promise<Plan> {
    const plan = await this.prisma.plan.findFirst({
      where: { isDefault: true, isActive: true },
      orderBy: { sortOrder: 'asc' },
    });
    if (!plan) {
      throw new NotFoundException(
        'No hay plan por defecto configurado. Ejecuta el seed de planes antes de operar.',
      );
    }
    return plan;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Plan efectivo de un espacio
  // ───────────────────────────────────────────────────────────────────────────

  async resolveForWorkspace(workspaceId: string): Promise<EffectivePlan> {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: {
        storageBytesUsed: true,
        subscription: { include: { plan: true } },
      },
    });
    if (!workspace) throw new NotFoundException('Espacio no encontrado');

    const subscription = workspace.subscription;
    // Una suscripción cancelada o impagada degrada al plan gratuito en vez de
    // bloquear el espacio: las fotos ya vendidas siguen siendo accesibles.
    const active = subscription && subscription.status === 'ACTIVE' ? subscription : null;
    const plan = active ? active.plan : await this.defaultPlan();

    const blockBytes = plan.extraStorageBlockBytes ?? BigInt(0);
    const extraBytes = blockBytes * BigInt(active?.extraStorageBlocks ?? 0);
    const allowance = plan.includedStorageBytes + extraBytes;
    const used = workspace.storageBytesUsed;

    return {
      plan,
      subscription: active,
      storageAllowanceBytes: allowance,
      storageUsedBytes: used,
      storageAvailableBytes: allowance > used ? allowance - used : BigInt(0),
      commissionPercent: Number(plan.commissionPercent),
    };
  }

  /**
   * Comisión de plataforma aplicable a las ventas de un espacio. Es la fuente de
   * verdad para el reparto: sustituye al porcentaje fijo por evento.
   */
  async commissionPercentFor(workspaceId: string | null | undefined): Promise<number | null> {
    if (!workspaceId) return null;
    try {
      const { commissionPercent } = await this.resolveForWorkspace(workspaceId);
      return commissionPercent;
    } catch (error) {
      this.logger.warn(
        `No se pudo resolver la comisión del espacio ${workspaceId}: ${
          error instanceof Error ? error.message : 'error desconocido'
        }`,
      );
      return null;
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Medidor de almacenamiento
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Comprueba que caben `bytes` más antes de subir. Se llama antes de escribir
   * en R2 para no pagar por objetos que luego habría que borrar.
   */
  /**
   * Comprueba que el plan del espacio incluye una capacidad concreta.
   *
   * Sin esto los planes solo se diferencian en comisión y almacenamiento: el
   * resto de lo que se anuncia en la página de precios estaba disponible para
   * todo el mundo, de pago o no.
   */
  async assertPlanAllows(
    workspaceId: string,
    feature: 'allowsCustomDomain' | 'allowsSponsors' | 'allowsAdvancedMetrics',
  ): Promise<void> {
    const { plan } = await this.resolveForWorkspace(workspaceId);
    if (plan[feature]) return;

    const names: Record<typeof feature, string> = {
      allowsCustomDomain: 'usar un dominio propio',
      allowsSponsors: 'trabajar con patrocinadores',
      allowsAdvancedMetrics: 'ver las métricas avanzadas',
    };
    const upgrade = await this.prisma.plan.findFirst({
      where: { isActive: true, [feature]: true },
      orderBy: { priceCents: 'asc' },
      select: { name: true, priceCents: true },
    });

    throw new ForbiddenException({
      code: 'PLAN_UPGRADE_REQUIRED',
      message: upgrade
        ? `Tu plan ${plan.name} no incluye ${names[feature]}. Está disponible desde ${upgrade.name} (${this.formatMoney(upgrade.priceCents)} al mes).`
        : `Tu plan ${plan.name} no incluye ${names[feature]}.`,
      feature,
    });
  }

  /** Administradores que admite el plan. Nulo significa sin límite. */
  async maxAdminsFor(workspaceId: string): Promise<number | null> {
    const { plan } = await this.resolveForWorkspace(workspaceId);
    return plan.maxAdmins ?? null;
  }

  async assertStorageAvailable(workspaceId: string | null | undefined, bytes: number): Promise<void> {
    if (!workspaceId || bytes <= 0) return;

    const { storageAvailableBytes, storageAllowanceBytes, plan } =
      await this.resolveForWorkspace(workspaceId);

    if (BigInt(bytes) > storageAvailableBytes) {
      throw new ForbiddenException({
        code: 'STORAGE_QUOTA_EXCEEDED',
        message: `Has agotado el almacenamiento de tu plan ${plan.name} (${this.formatBytes(
          storageAllowanceBytes,
        )}). Amplía el espacio o libera fotografías para seguir subiendo.`,
        allowanceBytes: storageAllowanceBytes.toString(),
        availableBytes: storageAvailableBytes.toString(),
        requiredBytes: bytes,
      });
    }
  }

  /**
   * Suma consumo al espacio. Idempotente por foto: el llamador pasa solo el
   * delta, nunca el total acumulado.
   */
  async addStorage(
    workspaceId: string | null | undefined,
    bytes: number,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    if (!workspaceId || !bytes) return;
    const client = tx ?? this.prisma;
    await client.workspace.update({
      where: { id: workspaceId },
      data: { storageBytesUsed: { increment: BigInt(Math.max(0, Math.round(bytes))) } },
    });
  }

  /**
   * Devuelve espacio al borrar fotografías. Nunca deja el contador en negativo.
   */
  async releaseStorage(
    workspaceId: string | null | undefined,
    bytes: number,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    if (!workspaceId || !bytes) return;
    const client = tx ?? this.prisma;
    const amount = BigInt(Math.max(0, Math.round(bytes)));
    // GREATEST evita que un borrado doble deje el medidor bajo cero.
    await client.$executeRaw`
      UPDATE "workspaces"
      SET "storage_bytes_used" = GREATEST(0, "storage_bytes_used" - ${amount}::bigint)
      WHERE "id" = ${workspaceId}::uuid
    `;
  }

  /**
   * Acumula el cargo del modo compartir: en eventos de descarga gratuita se
   * cobra por fotografía subida, que es cuando se incurre el coste (OCR,
   * reconocimiento facial, derivadas). Se acumula y se factura al cierre del
   * periodo, no se cobra foto a foto.
   *
   * @returns céntimos acumulados en esta llamada.
   */
  async accrueSharePhotoCharge(
    workspaceId: string | null | undefined,
    photos = 1,
  ): Promise<number> {
    if (!workspaceId || photos <= 0) return 0;

    const { plan } = await this.resolveForWorkspace(workspaceId);
    const perPhoto = Number(plan.sharePhotoCents);
    if (!perPhoto) return 0;

    const amount = perPhoto * photos;
    await this.prisma.workspace.update({
      where: { id: workspaceId },
      data: { pendingShareChargeCents: { increment: amount } },
    });
    return amount;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Modo compartir: cobro al publicar
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Cuánto cuesta publicar este evento en modo compartir. Se calcula sobre las
   * fotografías que tiene ahora, no sobre las subidas históricas: quien sube
   * 3 000 y descarta 800 paga por 2 200.
   */
  async estimatePublication(eventId: string) {
    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
      select: {
        id: true,
        name: true,
        commerceMode: true,
        workspaceId: true,
        shareChargedAt: true,
        shareChargeCents: true,
        // Solo fotografías realmente subidas: las provisionales de una subida
        // directa en vuelo no deben entrar en el importe.
        _count: { select: { photos: { where: { originalUrl: { not: 'pending' } } } } },
      },
    });
    if (!event) throw new NotFoundException('Evento no encontrado');

    const billable = this.isShareMode(event.commerceMode);
    if (!billable || !event.workspaceId) {
      return {
        billable: false,
        alreadyCharged: Boolean(event.shareChargedAt),
        photos: event._count.photos,
        perPhotoCents: 0,
        totalCents: 0,
        plan: null,
        upgrade: null,
      };
    }

    const { plan } = await this.resolveForWorkspace(event.workspaceId);
    const perPhoto = Number(plan.sharePhotoCents);
    const photos = event._count.photos;
    const totalCents = Math.round(perPhoto * photos);

    // Comparativa con el siguiente plan: el ahorro solo se enseña si de verdad
    // compensa pagar la mensualidad para este evento.
    const cheaper = await this.prisma.plan.findFirst({
      where: { isActive: true, sharePhotoCents: { lt: plan.sharePhotoCents } },
      orderBy: { priceCents: 'asc' },
    });
    let upgrade: { slug: string; name: string; priceCents: number; totalCents: number } | null = null;
    if (cheaper) {
      const upgradeTotal = Math.round(Number(cheaper.sharePhotoCents) * photos);
      if (upgradeTotal + cheaper.priceCents < totalCents) {
        upgrade = {
          slug: cheaper.slug,
          name: cheaper.name,
          priceCents: cheaper.priceCents,
          totalCents: upgradeTotal,
        };
      }
    }

    return {
      billable: true,
      alreadyCharged: Boolean(event.shareChargedAt),
      photos,
      perPhotoCents: perPhoto,
      totalCents: Boolean(event.shareChargedAt) ? 0 : totalCents,
      plan: { slug: plan.slug, name: plan.name },
      upgrade,
    };
  }

  /**
   * Cobra la publicación de un evento en modo compartir. Es idempotente: si ya
   * se cobró, despublicar y volver a publicar no vuelve a pasar la tarjeta.
   *
   * Lanza PAYMENT_METHOD_REQUIRED con el importe cuando falta tarjeta, para que
   * la interfaz pueda pedirla enseñando la cifra exacta.
   */
  async chargePublication(eventId: string): Promise<void> {
    // Comprobación barata primero: republicar es frecuente y no debe disparar
    // consultas de plan ni de catálogo.
    const already = await this.prisma.event.findUnique({
      where: { id: eventId },
      select: { shareChargedAt: true },
    });
    if (already?.shareChargedAt) return;

    const estimate = await this.estimatePublication(eventId);
    if (!estimate.billable || estimate.alreadyCharged) return;

    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
      select: { workspaceId: true, name: true },
    });
    if (!event?.workspaceId) return;

    // Sin importe no hay nada que cobrar, pero sí que marcar: un evento sin
    // fotografías publicado hoy no debe cobrarse retroactivamente mañana.
    if (estimate.totalCents <= 0) {
      await this.markPublicationCharged(eventId, 0, estimate.photos, null);
      return;
    }

    // En modo demo se publica sin cobrar, pero NO se marca como liquidado: el
    // importe queda pendiente y se puede reclamar cuando la pasarela esté lista.
    // Estampar la liquidación aquí regalaría el cobro de forma irreversible.
    if (this.demoPayments) {
      this.logger.warn(
        `DEMO_PAYMENTS activo: ${eventId} se publica sin cobrar ${this.formatMoney(estimate.totalCents)}`,
      );
      return;
    }

    // Sin pasarela y sin modo demo es un despliegue mal configurado. Fallar es
    // preferible a publicar gratis en silencio lo que debería facturarse.
    if (!this.stripe) {
      throw new BadRequestException({
        code: 'BILLING_NOT_CONFIGURED',
        message:
          'La facturación no está configurada, así que no se puede publicar un evento de descarga gratuita.',
      });
    }

    const workspace = await this.prisma.workspace.findUnique({
      where: { id: event.workspaceId },
      select: { stripeCustomerId: true, defaultPaymentMethodId: true, name: true },
    });

    if (!workspace?.stripeCustomerId || !workspace.defaultPaymentMethodId) {
      throw new BadRequestException({
        code: 'PAYMENT_METHOD_REQUIRED',
        message: `Publicar «${event.name}» cuesta ${this.formatMoney(
          estimate.totalCents,
        )} (${estimate.photos} fotografías). Añade un método de pago para continuar.`,
        estimate,
      });
    }

    try {
      const intent = await this.stripe.paymentIntents.create(
        {
          amount: estimate.totalCents,
          currency: 'usd',
          customer: workspace.stripeCustomerId,
          payment_method: workspace.defaultPaymentMethodId,
          off_session: true,
          confirm: true,
          description: `Publicación en modo compartir · ${event.name} · ${estimate.photos} fotografías`,
          metadata: { eventId, workspaceId: event.workspaceId, photos: String(estimate.photos) },
        },
        // La clave de idempotencia incluye el número de fotografías: si el
        // fotógrafo añade más y republica, es un cobro distinto y legítimo.
        { idempotencyKey: `lucilamon-share-${eventId}-${estimate.photos}` },
      );

      await this.markPublicationCharged(eventId, estimate.totalCents, estimate.photos, intent.id);
      this.logger.log(
        `Cobrada publicación de ${eventId}: ${this.formatMoney(estimate.totalCents)} (${intent.id})`,
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Error desconocido';
      this.logger.error(`No se pudo cobrar la publicación de ${eventId}: ${reason}`);
      throw new BadRequestException({
        code: 'SHARE_CHARGE_FAILED',
        message: `No se pudo completar el cobro de ${this.formatMoney(
          estimate.totalCents,
        )}. Revisa tu método de pago e inténtalo de nuevo.`,
        estimate,
      });
    }
  }

  private async markPublicationCharged(
    eventId: string,
    cents: number,
    photos: number,
    intentId: string | null,
  ) {
    await this.prisma.event.update({
      where: { id: eventId },
      data: {
        shareChargeCents: cents,
        shareChargePhotos: photos,
        shareChargedAt: new Date(),
        shareChargeIntentId: intentId,
      },
    });
  }

  /** En modo gratuito el atleta no paga, así que el coste lo asume el fotógrafo. */
  isShareMode(mode: string): boolean {
    return mode === 'FREE';
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Método de pago
  // ───────────────────────────────────────────────────────────────────────────

  /** Crea el cliente de Stripe del espacio la primera vez que hace falta. */
  private async ensureCustomer(workspaceId: string): Promise<string> {
    if (!this.stripe) throw new BadRequestException('La facturación no está configurada');

    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { stripeCustomerId: true, name: true, contactEmail: true, owner: { select: { email: true } } },
    });
    if (!workspace) throw new NotFoundException('Espacio no encontrado');
    if (workspace.stripeCustomerId) return workspace.stripeCustomerId;

    const customer = await this.stripe.customers.create({
      name: workspace.name,
      email: workspace.contactEmail || workspace.owner?.email || undefined,
      metadata: { workspaceId },
    });
    await this.prisma.workspace.update({
      where: { id: workspaceId },
      data: { stripeCustomerId: customer.id },
    });
    return customer.id;
  }

  /** Devuelve el secreto para que el navegador guarde la tarjeta con Stripe. */
  async startPaymentMethodSetup(workspaceId: string, userId: string, userRole: UserRole) {
    if (userRole !== UserRole.ADMIN) {
      await this.workspaces.assertAccess(workspaceId, userId, [WorkspaceRole.OWNER]);
    }
    if (!this.stripe) throw new BadRequestException('La facturación no está configurada');

    const customerId = await this.ensureCustomer(workspaceId);
    const intent = await this.stripe.setupIntents.create({
      customer: customerId,
      usage: 'off_session',
      metadata: { workspaceId },
    });
    return { clientSecret: intent.client_secret, customerId };
  }

  /** Fija como predeterminado el método que el navegador acaba de guardar. */
  async confirmPaymentMethod(
    workspaceId: string,
    paymentMethodId: string,
    userId: string,
    userRole: UserRole,
  ) {
    if (userRole !== UserRole.ADMIN) {
      await this.workspaces.assertAccess(workspaceId, userId, [WorkspaceRole.OWNER]);
    }
    if (!this.stripe) throw new BadRequestException('La facturación no está configurada');

    const customerId = await this.ensureCustomer(workspaceId);
    // Se vuelve a asociar por si el método se creó fuera de este flujo; Stripe
    // ignora la operación cuando ya pertenece al cliente.
    await this.stripe.paymentMethods
      .attach(paymentMethodId, { customer: customerId })
      .catch(() => undefined);
    await this.stripe.customers.update(customerId, {
      invoice_settings: { default_payment_method: paymentMethodId },
    });
    await this.prisma.workspace.update({
      where: { id: workspaceId },
      data: { defaultPaymentMethodId: paymentMethodId },
    });
    return { saved: true };
  }

  formatMoney(cents: number): string {
    return `$${(cents / 100).toFixed(2)}`;
  }

  /**
   * Recalcula el consumo real de un espacio desde las fotografías. Sirve para
   * corregir desvíos tras incidencias o migraciones.
   */
  async recalculateStorage(workspaceId: string): Promise<bigint> {
    const totals = await this.prisma.photo.aggregate({
      where: { photographerWorkspaceId: workspaceId },
      _sum: { originalBytes: true, derivedBytes: true },
    });
    const total =
      BigInt(totals._sum.originalBytes ?? 0) + BigInt(totals._sum.derivedBytes ?? 0);
    await this.prisma.workspace.update({
      where: { id: workspaceId },
      data: { storageBytesUsed: total },
    });
    this.logger.log(`Consumo recalculado para ${workspaceId}: ${this.formatBytes(total)}`);
    return total;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Panel de facturación
  // ───────────────────────────────────────────────────────────────────────────

  async overview(workspaceId: string, userId: string, userRole: UserRole) {
    if (userRole !== UserRole.ADMIN) {
      await this.workspaces.assertAccess(workspaceId, userId, [
        WorkspaceRole.OWNER,
        WorkspaceRole.ADMIN,
        WorkspaceRole.ANALYST,
      ]);
    }

    const effective = await this.resolveForWorkspace(workspaceId);
    const allowance = effective.storageAllowanceBytes;
    const used = effective.storageUsedBytes;
    const [photos, workspace] = await Promise.all([
      this.prisma.photo.count({ where: { photographerWorkspaceId: workspaceId } }),
      this.prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { pendingShareChargeCents: true },
      }),
    ]);
    const pendingShareCents = Number(workspace?.pendingShareChargeCents ?? 0);

    return {
      plan: {
        slug: effective.plan.slug,
        name: effective.plan.name,
        priceCents: effective.plan.priceCents,
        currency: effective.plan.currency,
        commissionPercent: effective.commissionPercent,
        sharePhotoCents: Number(effective.plan.sharePhotoCents),
        allowsCustomDomain: effective.plan.allowsCustomDomain,
        allowsSponsors: effective.plan.allowsSponsors,
        allowsAdvancedMetrics: effective.plan.allowsAdvancedMetrics,
        sponsoredEventFeeCents: effective.plan.sponsoredEventFeeCents,
        maxAdmins: effective.plan.maxAdmins,
      },
      // Modo compartir acumulado desde la última factura.
      shareMode: {
        pendingCents: pendingShareCents,
        pendingLabel: `$${(pendingShareCents / 100).toFixed(2)}`,
        perPhotoCents: Number(effective.plan.sharePhotoCents),
      },
      subscription: effective.subscription
        ? {
            status: effective.subscription.status,
            extraStorageBlocks: effective.subscription.extraStorageBlocks,
            currentPeriodEnd: effective.subscription.currentPeriodEnd,
            cancelAtPeriodEnd: effective.subscription.cancelAtPeriodEnd,
          }
        : null,
      storage: {
        usedBytes: used.toString(),
        allowanceBytes: allowance.toString(),
        availableBytes: effective.storageAvailableBytes.toString(),
        usedLabel: this.formatBytes(used),
        allowanceLabel: this.formatBytes(allowance),
        percentUsed:
          allowance > BigInt(0) ? Math.min(100, Number((used * BigInt(1000)) / allowance) / 10) : 0,
        photos,
        extraBlockBytes: effective.plan.extraStorageBlockBytes?.toString() ?? null,
        extraBlockCents: effective.plan.extraStorageBlockCents ?? null,
      },
    };
  }

  /**
   * Cambia el plan de un espacio. El cobro de la mensualidad ocurre aquí mismo,
   * de forma síncrona: si la tarjeta se rechaza, esto lanza y el espacio
   * conserva el plan que ya tenía.
   */
  async changePlan(
    workspaceId: string,
    planSlug: string,
    extraStorageBlocks: number,
    userId: string,
    userRole: UserRole,
  ) {
    if (userRole !== UserRole.ADMIN) {
      await this.workspaces.assertAccess(workspaceId, userId, [WorkspaceRole.OWNER]);
    }
    if (extraStorageBlocks < 0 || !Number.isInteger(extraStorageBlocks)) {
      throw new BadRequestException('Los bloques adicionales deben ser un entero no negativo');
    }

    const plan = await this.prisma.plan.findUnique({ where: { slug: planSlug } });
    if (!plan || !plan.isActive) throw new NotFoundException('Plan no encontrado');
    if (extraStorageBlocks > 0 && !plan.extraStorageBlockBytes) {
      throw new BadRequestException(`El plan ${plan.name} no admite ampliaciones de espacio`);
    }

    // Bajar de plan no puede dejar al espacio por encima del cupo: sería un
    // estado imposible de resolver salvo borrando fotografías ajenas.
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { storageBytesUsed: true },
    });
    if (!workspace) throw new NotFoundException('Espacio no encontrado');

    const newAllowance =
      plan.includedStorageBytes +
      (plan.extraStorageBlockBytes ?? BigInt(0)) * BigInt(extraStorageBlocks);

    if (workspace.storageBytesUsed > newAllowance) {
      throw new BadRequestException({
        code: 'STORAGE_ABOVE_NEW_PLAN',
        message: `Ahora ocupas ${this.formatBytes(
          workspace.storageBytesUsed,
        )} y el plan elegido cubre ${this.formatBytes(
          newAllowance,
        )}. Libera espacio antes de cambiar de plan.`,
      });
    }

    // El cobro va PRIMERO: si la tarjeta falla, esto lanza y el espacio se queda
    // en el plan que ya tenía. Guardar antes de cobrar regalaría el plan cada vez
    // que un pago fuese rechazado.
    const stripeState = await this.planSubscriptions.applyPlan(workspaceId, plan, extraStorageBlocks);

    const subscription = await this.prisma.subscription.upsert({
      where: { workspaceId },
      create: {
        workspaceId,
        planId: plan.id,
        extraStorageBlocks,
        ...stripeState,
      },
      update: {
        planId: plan.id,
        extraStorageBlocks,
        cancelAtPeriodEnd: false,
        ...stripeState,
      },
    });

    return {
      ...subscription,
      plan: {
        slug: plan.slug,
        name: plan.name,
        priceCents: plan.priceCents,
        commissionPercent: Number(plan.commissionPercent),
        includedStorageBytes: plan.includedStorageBytes.toString(),
      },
      storageAllowanceBytes: newAllowance.toString(),
    };
  }

  formatBytes(value: bigint | number): string {
    const bytes = typeof value === 'bigint' ? Number(value) : value;
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let size = bytes / 1024;
    let unit = 0;
    while (size >= 1024 && unit < units.length - 1) {
      size /= 1024;
      unit++;
    }
    return `${size >= 10 || Number.isInteger(size) ? Math.round(size) : size.toFixed(1)} ${units[unit]}`;
  }
}
