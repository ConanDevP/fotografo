import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/services/prisma.service';
import { SharpTransformService } from '../common/services/sharp-transform.service';
import { BillingService } from '../billing/billing.service';
import { getErrorMessage } from '@shared/utils';

@Injectable()
export class ShareCardService {
  private readonly logger = new Logger(ShareCardService.name);

  constructor(
    private prisma: PrismaService,
    private sharpTransform: SharpTransformService,
    private billing: BillingService,
  ) {}

  async buildShareCard(eventId: string, photoId: string): Promise<Buffer> {
    const [photo, event, face] = await Promise.all([
      this.prisma.photo.findFirst({
        where: { id: photoId, eventId, status: 'PROCESSED', publicationStatus: 'APPROVED' },
        select: { watermarkUrl: true },
      }),
      this.prisma.event.findUnique({
        where: { id: eventId, deletedAt: null },
        select: {
          name: true,
          workspace: {
            select: {
              id: true,
              name: true,
              logoUrl: true,
              brandTheme: { select: { accentColor: true, settings: true } },
            },
          },
        },
      }),
      this.prisma.faceEmbedding.findFirst({
        where: { photoId },
        orderBy: { confidence: 'desc' },
        select: { bbox: true },
      }),
    ]);

    if (!photo?.watermarkUrl) throw new NotFoundException('Fotografía no disponible');
    if (!event) throw new NotFoundException('Evento no encontrado');

    const workspace = event.workspace;
    const accentColor = workspace?.brandTheme?.accentColor || '#C6FF00';

    // "Ocultar Impulsado por LucilaMon" es marca blanca: solo vale si el plan
    // del espacio la permite. Mismo criterio que usa la landing pública, para
    // que la tarjeta para compartir no filtre marca blanca a quien no la pagó.
    const settings = (workspace?.brandTheme?.settings as Record<string, unknown> | null) ?? {};
    let showCredit = true;
    if (settings.hidePlatformCredit === true && workspace) {
      const whiteLabelAllowed = await this.billing
        .resolveForWorkspace(workspace.id)
        .then(({ plan, enterprise }) => Boolean(plan.allowsCustomDomain || !plan.isDefault || enterprise))
        .catch(() => false);
      showCredit = !whiteLabelAllowed;
    }

    const [imageBuffer, logoBuffer] = await Promise.all([
      this.fetchImageBuffer(photo.watermarkUrl),
      workspace?.logoUrl ? this.fetchImageBuffer(workspace.logoUrl).catch(() => null) : Promise.resolve(null),
    ]);

    const bbox = (face?.bbox as [number, number, number, number] | null) ?? null;

    return this.sharpTransform.generateShareCard(imageBuffer, bbox, {
      eventName: event.name,
      workspaceName: workspace?.name ?? 'LucilaMon',
      logoBuffer,
      accentColor,
      showCredit,
    });
  }

  private async fetchImageBuffer(url: string): Promise<Buffer> {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`Respuesta ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      this.logger.warn(`No se pudo descargar ${url}: ${getErrorMessage(error)}`);
      throw error;
    }
  }
}
