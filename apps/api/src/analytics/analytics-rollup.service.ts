import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/services/prisma.service';

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';
/** Ventana del pase nocturno. El incremental ya mantiene 3 días perfectos; esto
 * solo corrige llegadas tardías, que casi nunca superan un mes. */
const NIGHTLY_WINDOW_DAYS = 35;
/** Retención por defecto de la captura cruda. Los rollups ya están calculados. */
const DEFAULT_RAW_RETENTION_DAYS = 540;

/**
 * Mantiene la capa de agregación de analítica.
 *
 * `metric_events` es la captura cruda; consultarla en cada carga de dashboard no
 * escala. Aquí se consolida en `metric_daily_rollup` (día × espacio × evento ×
 * tipo), `sponsor_daily_rollup` y `event_analytics_snapshot`.
 *
 * - Incremental cada 10 min: reconstruye la ventana de los últimos 3 días.
 * - Nocturno: reconstruye 35 días y refresca las instantáneas de eventos
 *   recientes.
 * - Semanal: purga la captura cruda más antigua que la retención.
 *
 * Un `pg_try_advisory_xact_lock` evita que dos instancias de la API (o el
 * incremental y el nocturno) pisen la misma ventana a la vez.
 */
@Injectable()
export class AnalyticsRollupService implements OnModuleInit {
  private readonly logger = new Logger(AnalyticsRollupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit() {
    // Un primer pase poco después de arrancar para que un despliegue nuevo no
    // tenga que esperar al minuto 10 para mostrar datos.
    setTimeout(() => {
      this.rebuildWindow(3, 'boot').catch(error =>
        this.logger.warn(`Rollup de arranque falló: ${error instanceof Error ? error.message : 'error'}`),
      );
    }, 20_000);
  }

  @Cron('*/10 * * * *')
  async incremental(): Promise<void> {
    await this.rebuildWindow(3, 'incremental').catch(error =>
      this.logger.error(`Rollup incremental falló: ${error instanceof Error ? error.message : 'error'}`),
    );
  }

  @Cron('15 3 * * *')
  async nightly(): Promise<void> {
    try {
      await this.rebuildWindow(NIGHTLY_WINDOW_DAYS, 'nocturno');
      await this.refreshRecentSnapshots();
    } catch (error) {
      this.logger.error(`Rollup nocturno falló: ${error instanceof Error ? error.message : 'error'}`);
    }
  }

  /** Purga semanal de la captura cruda. Los rollups ya están consolidados. */
  @Cron('40 4 * * 0')
  async purgeRawMetrics(): Promise<void> {
    const days = Math.max(
      NIGHTLY_WINDOW_DAYS + 5,
      Number(this.config.get('METRICS_RAW_RETENTION_DAYS', DEFAULT_RAW_RETENTION_DAYS)) ||
        DEFAULT_RAW_RETENTION_DAYS,
    );
    const cutoff = new Date(Date.now() - days * 86_400_000);
    try {
      let total = 0;
      // En lotes para no coger un lock largo sobre la tabla.
      for (let i = 0; i < 200; i++) {
        const deleted = await this.prisma.$executeRaw`
          DELETE FROM "metric_events"
          WHERE "id" IN (
            SELECT "id" FROM "metric_events" WHERE "created_at" < ${cutoff} LIMIT 10000
          )
        `;
        total += Number(deleted);
        if (Number(deleted) < 10000) break;
      }
      if (total > 0) {
        this.logger.log(`Purga de metric_events: ${total} fila(s) anteriores a ${cutoff.toISOString().slice(0, 10)}`);
      }
    } catch (error) {
      this.logger.error(`Purga de metric_events falló: ${error instanceof Error ? error.message : 'error'}`);
    }
  }

  /**
   * Borra y reconstruye la ventana de `days` días en las tres tablas de rollup.
   * Delete + insert (en vez de upsert) mantiene los contadores exactos aunque se
   * hayan borrado eventos o métricas dentro de la ventana.
   */
  private async rebuildWindow(days: number, label: string): Promise<void> {
    const startedAt = Date.now();
    const since = new Date(Date.now() - days * 86_400_000);

    await this.prisma.$transaction(
      async tx => {
        // Lock cooperativo con claves int4 literales (evita la ambigüedad de
        // sobrecarga bigint/int cuando se pasan como parámetro). Compartido por
        // el pase incremental y el nocturno para que no se solapen.
        const locked = await tx.$queryRaw<Array<{ locked: boolean }>>`
          SELECT pg_try_advisory_xact_lock(4923771, 7) AS locked
        `;
        if (!locked[0]?.locked) {
          this.logger.log(`Rollup ${label}: otra ejecución tiene el lock, se omite`);
          return;
        }

        // ── metric_daily_rollup ────────────────────────────────────────────
        await tx.$executeRaw`
          DELETE FROM "metric_daily_rollup" WHERE "day" >= (${since})::date
        `;

        // Filas por evento.
        await tx.$executeRaw`
          INSERT INTO "metric_daily_rollup"
            ("day", "workspace_id", "event_id", "event_key", "metric_type", "count", "unique_visitors", "updated_at")
          SELECT ("me"."created_at" AT TIME ZONE 'UTC')::date AS day,
                 "me"."workspace_id",
                 "me"."event_id",
                 "me"."event_id",
                 "me"."type",
                 COUNT(*)::int,
                 COUNT(DISTINCT COALESCE("me"."day_visitor_hash", "me"."visitor_hash"))::int,
                 now()
          FROM "metric_events" "me"
          WHERE "me"."created_at" >= ${since}
            AND "me"."workspace_id" IS NOT NULL
            AND "me"."event_id" IS NOT NULL
            AND COALESCE("me"."is_bot", false) = false
            AND COALESCE("me"."is_internal", false) = false
          GROUP BY 1, "me"."workspace_id", "me"."event_id", "me"."type"
        `;

        // Filas de nivel espacio (event_key = UUID cero).
        await tx.$executeRaw`
          INSERT INTO "metric_daily_rollup"
            ("day", "workspace_id", "event_id", "event_key", "metric_type", "count", "unique_visitors", "updated_at")
          SELECT ("me"."created_at" AT TIME ZONE 'UTC')::date AS day,
                 "me"."workspace_id",
                 NULL,
                 ${ZERO_UUID}::uuid,
                 "me"."type",
                 COUNT(*)::int,
                 COUNT(DISTINCT COALESCE("me"."day_visitor_hash", "me"."visitor_hash"))::int,
                 now()
          FROM "metric_events" "me"
          WHERE "me"."created_at" >= ${since}
            AND "me"."workspace_id" IS NOT NULL
            AND COALESCE("me"."is_bot", false) = false
            AND COALESCE("me"."is_internal", false) = false
          GROUP BY 1, "me"."workspace_id", "me"."type"
        `;

        // ── sponsor_daily_rollup ──────────────────────────────────────────
        await tx.$executeRaw`
          DELETE FROM "sponsor_daily_rollup" WHERE "day" >= (${since})::date
        `;
        await tx.$executeRaw`
          INSERT INTO "sponsor_daily_rollup"
            ("day", "sponsor_id", "event_id", "event_key", "impressions", "clicks", "unique_reach", "updated_at")
          SELECT ("me"."created_at" AT TIME ZONE 'UTC')::date AS day,
                 (jsonb_extract_path_text("me"."metadata", 'sponsorId'))::uuid AS sponsor_id,
                 "me"."event_id",
                 COALESCE("me"."event_id", ${ZERO_UUID}::uuid),
                 COUNT(*) FILTER (WHERE "me"."type" = 'SPONSOR_DOWNLOAD_EXPOSURE')::int,
                 COUNT(*) FILTER (WHERE "me"."type" = 'SPONSOR_CLICK')::int,
                 COUNT(DISTINCT COALESCE("me"."day_visitor_hash", "me"."visitor_hash"))::int,
                 now()
          FROM "metric_events" "me"
          WHERE "me"."created_at" >= ${since}
            AND "me"."type" IN ('SPONSOR_CLICK', 'SPONSOR_DOWNLOAD_EXPOSURE')
            AND jsonb_extract_path_text("me"."metadata", 'sponsorId') ~ '^[0-9a-fA-F-]{36}$'
            AND COALESCE("me"."is_bot", false) = false
          GROUP BY 1, 2, "me"."event_id"
        `;

        const elapsed = Date.now() - startedAt;
        const line = `Rollup ${label} ok — ventana ${days}d desde ${since.toISOString().slice(0, 10)} (${elapsed}ms)`;
        // Si el pase se acerca al timeout de la transacción, hay que reducir la
        // ventana o batchearlo por espacio antes de que empiece a fallar.
        if (elapsed > 60_000) this.logger.warn(`${line} — lento, revisar tamaño de metric_events`);
        else this.logger.log(line);
      },
      { timeout: 180_000, maxWait: 10_000 },
    );
  }

  /**
   * Refresca las instantáneas de eventos recientes o con actividad. Se ejecuta en
   * el pase nocturno; el resto del tiempo cada dashboard recalcula la suya bajo
   * demanda si está vieja.
   */
  private async refreshRecentSnapshots(): Promise<void> {
    const horizon = new Date(Date.now() - 45 * 86_400_000);
    const touched = new Date(Date.now() - 2 * 86_400_000);
    const events = await this.prisma.event.findMany({
      where: {
        deletedAt: null,
        OR: [{ date: { gte: horizon } }, { createdAt: { gte: touched } }, { publishedAt: { gte: touched } }],
      },
      select: { id: true },
      take: 800,
      orderBy: { date: 'desc' },
    });

    let ok = 0;
    for (const { id } of events) {
      try {
        await this.computeEventSnapshot(id);
        ok++;
      } catch (error) {
        this.logger.warn(
          `Instantánea de ${id} falló: ${error instanceof Error ? error.message : 'error desconocido'}`,
        );
      }
    }
    this.logger.log(`Instantáneas refrescadas: ${ok}/${events.length}`);
  }

  private async n(sql: Prisma.Sql): Promise<number> {
    const rows = await this.prisma.$queryRaw<Array<{ v: bigint | number | null }>>(sql);
    return Number(rows[0]?.v ?? 0);
  }

  /**
   * Recalcula la instantánea analítica de un evento. Todas las consultas están
   * acotadas a ese evento, así que es barato incluso en carreras grandes.
   */
  async computeEventSnapshot(eventId: string): Promise<void> {
    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
      select: { id: true, workspaceId: true, bibRules: true, totalFreeDownloads: true },
    });
    if (!event) return;

    const fieldSize = this.readFieldSize(event.bibRules);

    const [
      totalPhotos,
      processedPhotos,
      photosWithBib,
      photosWithFace,
      distinctBibs,
      distinctInferredBibs,
      bibsWithSale,
      bibsSearched,
      uniqueVisitors,
      rollupGroups,
      ledgerGroups,
      paidOrders,
      freeDownloads,
      countryRows,
      deviceRows,
      channelRows,
      seriesRows,
    ] = await Promise.all([
      this.prisma.photo.count({ where: { eventId } }),
      this.prisma.photo.count({ where: { eventId, status: 'PROCESSED' } }),
      this.n(Prisma.sql`SELECT COUNT(DISTINCT "photo_id")::bigint AS v FROM "photo_bibs" WHERE "event_id" = ${eventId}::uuid`),
      this.n(Prisma.sql`SELECT COUNT(DISTINCT "photo_id")::bigint AS v FROM "face_embeddings" WHERE "event_id" = ${eventId}::uuid`),
      this.n(Prisma.sql`SELECT COUNT(DISTINCT "bib")::bigint AS v FROM "photo_bibs" WHERE "event_id" = ${eventId}::uuid`),
      this.n(Prisma.sql`SELECT COUNT(DISTINCT "bib")::bigint AS v FROM "inferred_bibs" WHERE "event_id" = ${eventId}::uuid AND "rejected" = false`),
      this.n(Prisma.sql`
        SELECT COUNT(DISTINCT "pb"."bib")::bigint AS v
        FROM "photo_bibs" "pb"
        JOIN "order_items" "oi" ON "oi"."photo_id" = "pb"."photo_id"
        JOIN "orders" "o" ON "o"."id" = "oi"."order_id"
        WHERE "pb"."event_id" = ${eventId}::uuid AND "o"."status" = 'PAID'
      `),
      this.n(Prisma.sql`
        SELECT COUNT(DISTINCT jsonb_extract_path_text("metadata", 'bib'))::bigint AS v
        FROM "metric_events"
        WHERE "event_id" = ${eventId}::uuid AND "type" = 'BIB_SEARCH'
          AND jsonb_extract_path_text("metadata", 'bib') IS NOT NULL
      `),
      this.n(Prisma.sql`
        SELECT COUNT(DISTINCT COALESCE("day_visitor_hash", "visitor_hash"))::bigint AS v
        FROM "metric_events"
        WHERE "event_id" = ${eventId}::uuid
          AND COALESCE("is_bot", false) = false AND COALESCE("is_internal", false) = false
          AND "created_at" >= now() - interval '180 days'
      `),
      this.prisma.metricDailyRollup.groupBy({
        by: ['metricType'],
        where: { eventId },
        _sum: { count: true, uniqueVisitors: true },
      }),
      this.prisma.ledgerEntry.groupBy({
        by: ['type'],
        where: { eventId },
        _sum: { amountCents: true },
      }),
      this.prisma.order.count({ where: { eventId, status: 'PAID' } }),
      this.prisma.freeDownload.count({ where: { eventId } }),
      this.prisma.$queryRaw<Array<{ k: string; c: bigint }>>(Prisma.sql`
        SELECT "country" AS k, COUNT(*)::bigint AS c FROM "metric_events"
        WHERE "event_id" = ${eventId}::uuid AND "country" IS NOT NULL
          AND COALESCE("is_bot", false) = false AND COALESCE("is_internal", false) = false
          AND "created_at" >= now() - interval '180 days'
        GROUP BY "country" ORDER BY c DESC LIMIT 12
      `),
      this.prisma.$queryRaw<Array<{ k: string; c: bigint }>>(Prisma.sql`
        SELECT COALESCE("device", 'unknown') AS k, COUNT(*)::bigint AS c FROM "metric_events"
        WHERE "event_id" = ${eventId}::uuid
          AND COALESCE("is_bot", false) = false AND COALESCE("is_internal", false) = false
          AND "created_at" >= now() - interval '180 days'
        GROUP BY 1 ORDER BY c DESC LIMIT 6
      `),
      this.prisma.$queryRaw<Array<{ k: string; c: bigint }>>(Prisma.sql`
        SELECT COALESCE("channel", 'direct') AS k, COUNT(*)::bigint AS c FROM "metric_events"
        WHERE "event_id" = ${eventId}::uuid
          AND COALESCE("is_bot", false) = false AND COALESCE("is_internal", false) = false
          AND "created_at" >= now() - interval '180 days'
        GROUP BY 1 ORDER BY c DESC LIMIT 12
      `),
      this.prisma.metricDailyRollup.findMany({
        where: { eventId, day: { gte: new Date(Date.now() - 120 * 86_400_000) } },
        select: { day: true, metricType: true, count: true },
        orderBy: { day: 'asc' },
      }),
    ]);

    const rollup = Object.fromEntries(
      rollupGroups.map(g => [g.metricType, g._sum.count ?? 0]),
    ) as Record<string, number>;
    const ledger = Object.fromEntries(
      ledgerGroups.map(g => [g.type, Math.abs(g._sum.amountCents ?? 0)]),
    ) as Record<string, number>;

    const grossCents =
      ledger.GROSS_SALE ??
      (await this.prisma.order.aggregate({ where: { eventId, status: 'PAID' }, _sum: { amountCents: true } }))._sum
        .amountCents ??
      0;

    await this.prisma.eventAnalyticsSnapshot.upsert({
      where: { eventId },
      create: {
        eventId,
        workspaceId: event.workspaceId,
        totalPhotos,
        processedPhotos,
        photosWithBib,
        photosWithFace,
        photosNoBib: Math.max(0, processedPhotos - photosWithBib),
        distinctBibs,
        distinctInferredBibs,
        fieldSize,
        bibsSearched,
        bibsWithSale,
        eventViews: rollup.EVENT_VIEW ?? 0,
        photoViews: rollup.PHOTO_VIEW ?? 0,
        uniqueVisitors,
        bibSearches: rollup.BIB_SEARCH ?? 0,
        faceSearches: rollup.FACE_SEARCH ?? 0,
        noResultSearches: rollup.SEARCH_NO_RESULTS ?? 0,
        addToCart: rollup.ADD_TO_CART ?? 0,
        checkoutStarted: rollup.CHECKOUT_STARTED ?? 0,
        purchases: Math.max(rollup.PURCHASE_COMPLETED ?? 0, paidOrders),
        freeDownloads: Math.max(rollup.FREE_DOWNLOAD ?? 0, freeDownloads, event.totalFreeDownloads ?? 0),
        paidDownloads: rollup.PAID_DOWNLOAD ?? 0,
        grossCents,
        netPlatformCents: ledger.PLATFORM_FEE ?? 0,
        organizerCommissionCents: ledger.ORGANIZER_COMMISSION ?? 0,
        photographerEarningCents: ledger.PHOTOGRAPHER_EARNING ?? 0,
        refundCents: ledger.REFUND ?? 0,
        sponsorImpressions: rollup.SPONSOR_DOWNLOAD_EXPOSURE ?? 0,
        sponsorClicks: rollup.SPONSOR_CLICK ?? 0,
        topCountries: countryRows.map(r => ({ country: r.k, count: Number(r.c) })),
        deviceSplit: deviceRows.map(r => ({ device: r.k, count: Number(r.c) })),
        channelSplit: channelRows.map(r => ({ channel: r.k, count: Number(r.c) })),
        dailySeries: this.buildSeries(seriesRows),
        computedAt: new Date(),
      },
      update: {
        workspaceId: event.workspaceId,
        totalPhotos,
        processedPhotos,
        photosWithBib,
        photosWithFace,
        photosNoBib: Math.max(0, processedPhotos - photosWithBib),
        distinctBibs,
        distinctInferredBibs,
        fieldSize,
        bibsSearched,
        bibsWithSale,
        eventViews: rollup.EVENT_VIEW ?? 0,
        photoViews: rollup.PHOTO_VIEW ?? 0,
        uniqueVisitors,
        bibSearches: rollup.BIB_SEARCH ?? 0,
        faceSearches: rollup.FACE_SEARCH ?? 0,
        noResultSearches: rollup.SEARCH_NO_RESULTS ?? 0,
        addToCart: rollup.ADD_TO_CART ?? 0,
        checkoutStarted: rollup.CHECKOUT_STARTED ?? 0,
        purchases: Math.max(rollup.PURCHASE_COMPLETED ?? 0, paidOrders),
        freeDownloads: Math.max(rollup.FREE_DOWNLOAD ?? 0, freeDownloads, event.totalFreeDownloads ?? 0),
        paidDownloads: rollup.PAID_DOWNLOAD ?? 0,
        grossCents,
        netPlatformCents: ledger.PLATFORM_FEE ?? 0,
        organizerCommissionCents: ledger.ORGANIZER_COMMISSION ?? 0,
        photographerEarningCents: ledger.PHOTOGRAPHER_EARNING ?? 0,
        refundCents: ledger.REFUND ?? 0,
        sponsorImpressions: rollup.SPONSOR_DOWNLOAD_EXPOSURE ?? 0,
        sponsorClicks: rollup.SPONSOR_CLICK ?? 0,
        topCountries: countryRows.map(r => ({ country: r.k, count: Number(r.c) })),
        deviceSplit: deviceRows.map(r => ({ device: r.k, count: Number(r.c) })),
        channelSplit: channelRows.map(r => ({ channel: r.k, count: Number(r.c) })),
        dailySeries: this.buildSeries(seriesRows),
        computedAt: new Date(),
      },
    });
  }

  private readFieldSize(bibRules: unknown): number | null {
    if (!bibRules || typeof bibRules !== 'object') return null;
    const r = bibRules as Record<string, any>;
    const candidates = [r.fieldSize, r.participants, Array.isArray(r.range) ? r.range[1] : undefined, r.max, r.maxBib];
    for (const c of candidates) {
      const n = Number(c);
      if (Number.isFinite(n) && n > 0 && n < 1_000_000) return Math.round(n);
    }
    return null;
  }

  private buildSeries(rows: Array<{ day: Date; metricType: string; count: number }>) {
    const keyByType: Record<string, string> = {
      EVENT_VIEW: 'views',
      PHOTO_VIEW: 'photoViews',
      BIB_SEARCH: 'bibSearches',
      FACE_SEARCH: 'faceSearches',
      SEARCH_NO_RESULTS: 'noResults',
      ADD_TO_CART: 'addToCart',
      CHECKOUT_STARTED: 'checkout',
      PURCHASE_COMPLETED: 'purchases',
      FREE_DOWNLOAD: 'freeDownloads',
      PAID_DOWNLOAD: 'paidDownloads',
    };
    const byDay = new Map<string, Record<string, number>>();
    for (const row of rows) {
      const key = keyByType[row.metricType];
      if (!key) continue;
      const day = row.day.toISOString().slice(0, 10);
      const bucket = byDay.get(day) ?? {};
      bucket[key] = (bucket[key] ?? 0) + row.count;
      byDay.set(day, bucket);
    }
    return [...byDay.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, values]) => ({ day, ...values }));
  }
}
