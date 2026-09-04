import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { createCipheriv, createDecipheriv, createHmac, createHash, randomBytes, randomUUID } from 'crypto';
import { lookup } from 'dns/promises';
import { isIP } from 'net';
import { PrismaService } from '../common/services/prisma.service';
import { PartnerPrincipal } from './partner-api.types';
import { CreatePartnerWebhookDto, UpdatePartnerWebhookDto } from './dto/partner-webhook.dto';
import { PartnerWebhookEvent } from './partner-webhook.events';

@Injectable()
export class PartnerWebhooksService {
  private readonly logger = new Logger(PartnerWebhooksService.name);
  private readonly key: Buffer;

  constructor(private readonly prisma: PrismaService, config: ConfigService) {
    this.key = createHash('sha256').update(config.get<string>('PARTNER_WEBHOOK_ENCRYPTION_KEY') || 'development-only-webhook-key').digest();
  }

  async list(principal: PartnerPrincipal) {
    return this.prisma.partnerWebhookEndpoint.findMany({
      where: { workspaceId: principal.workspaceId, apiClientId: principal.apiClientId },
      select: { id: true, url: true, events: true, active: true, createdAt: true, updatedAt: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async create(principal: PartnerPrincipal, dto: CreatePartnerWebhookDto) {
    await this.assertPublicHttps(dto.url);
    const secret = `whsec_${randomBytes(32).toString('base64url')}`;
    const endpoint = await this.prisma.partnerWebhookEndpoint.create({
      data: {
        workspaceId: principal.workspaceId,
        apiClientId: principal.apiClientId,
        url: dto.url,
        events: [...new Set(dto.events)],
        secretEncrypted: this.encrypt(secret),
      },
      select: { id: true, url: true, events: true, active: true, createdAt: true },
    });
    return { ...endpoint, signingSecret: secret };
  }

  async update(principal: PartnerPrincipal, endpointId: string, dto: UpdatePartnerWebhookDto) {
    await this.find(principal, endpointId);
    if (dto.url) await this.assertPublicHttps(dto.url);
    return this.prisma.partnerWebhookEndpoint.update({
      where: { id: endpointId },
      data: { ...(dto.url ? { url: dto.url } : {}), ...(dto.events ? { events: [...new Set(dto.events)] } : {}), ...(dto.active !== undefined ? { active: dto.active } : {}) },
      select: { id: true, url: true, events: true, active: true, createdAt: true, updatedAt: true },
    });
  }

  async remove(principal: PartnerPrincipal, endpointId: string) {
    await this.find(principal, endpointId);
    await this.prisma.partnerWebhookEndpoint.delete({ where: { id: endpointId } });
    return { deleted: true };
  }

  async rotateSecret(principal: PartnerPrincipal, endpointId: string) {
    await this.find(principal, endpointId);
    const secret = `whsec_${randomBytes(32).toString('base64url')}`;
    const endpoint = await this.prisma.partnerWebhookEndpoint.update({
      where: { id: endpointId }, data: { secretEncrypted: this.encrypt(secret) }, select: { id: true },
    });
    return { ...endpoint, signingSecret: secret };
  }

  async deliveries(principal: PartnerPrincipal, endpointId: string) {
    await this.find(principal, endpointId);
    return this.prisma.partnerWebhookDelivery.findMany({
      where: { endpointId, workspaceId: principal.workspaceId }, orderBy: { createdAt: 'desc' }, take: 100,
      select: { id: true, eventId: true, eventType: true, status: true, attempts: true, responseStatus: true, lastError: true, nextAttemptAt: true, deliveredAt: true, createdAt: true },
    });
  }

  async retry(principal: PartnerPrincipal, deliveryId: string) {
    const delivery = await this.prisma.partnerWebhookDelivery.findFirst({
      where: {
        id: deliveryId,
        workspaceId: principal.workspaceId,
        endpoint: { apiClientId: principal.apiClientId },
      },
      select: { id: true },
    });
    if (!delivery) throw new NotFoundException('Entrega webhook no encontrada');
    return this.prisma.partnerWebhookDelivery.update({ where: { id: deliveryId }, data: { status: 'PENDING', attempts: 0, nextAttemptAt: new Date(), lastError: null } });
  }

  async emit(workspaceId: string, eventType: PartnerWebhookEvent, data: unknown) {
    const endpoints = await this.prisma.partnerWebhookEndpoint.findMany({ where: { workspaceId, active: true, events: { has: eventType } }, select: { id: true } });
    if (!endpoints.length) return;
    const eventId = randomUUID();
    await this.prisma.partnerWebhookDelivery.createMany({
      data: endpoints.map(endpoint => ({ endpointId: endpoint.id, workspaceId, eventId, eventType, payload: JSON.parse(JSON.stringify(data)) })),
      skipDuplicates: true,
    });
  }

  @Cron('*/15 * * * * *')
  async deliverPending() {
    const due = await this.prisma.partnerWebhookDelivery.findMany({
      where: {
        OR: [
          { status: { in: ['PENDING', 'RETRY'] }, nextAttemptAt: { lte: new Date() } },
          { status: 'PROCESSING', updatedAt: { lt: new Date(Date.now() - 2 * 60_000) } },
        ],
        attempts: { lt: 8 }, endpoint: { active: true },
      },
      orderBy: { nextAttemptAt: 'asc' }, take: 25, include: { endpoint: true },
    });
    await Promise.allSettled(due.map(item => this.deliver(item)));
  }

  private async deliver(item: any) {
    const claimed = await this.prisma.partnerWebhookDelivery.updateMany({
      where: {
        id: item.id,
        OR: [
          { status: { in: ['PENDING', 'RETRY'] } },
          { status: 'PROCESSING', updatedAt: { lt: new Date(Date.now() - 2 * 60_000) } },
        ],
      },
      data: { status: 'PROCESSING', attempts: { increment: 1 } },
    });
    if (!claimed.count) return;
    try {
      await this.assertPublicHttps(item.endpoint.url);
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const body = JSON.stringify({ id: item.eventId, type: item.eventType, createdAt: item.createdAt, data: item.payload });
      const signature = createHmac('sha256', this.decrypt(item.endpoint.secretEncrypted)).update(`${timestamp}.${body}`).digest('hex');
      const response = await fetch(item.endpoint.url, {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10_000),
        headers: { 'content-type': 'application/json', 'user-agent': 'LucilaMon-Webhooks/1.0', 'x-lucilamon-event-id': item.eventId, 'x-lucilamon-timestamp': timestamp, 'x-lucilamon-signature': `v1=${signature}` },
        body,
      });
      await response.body?.cancel().catch(() => undefined);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await this.prisma.partnerWebhookDelivery.update({ where: { id: item.id }, data: { status: 'DELIVERED', responseStatus: response.status, deliveredAt: new Date(), lastError: null } });
    } catch (error: any) {
      const attempts = item.attempts + 1;
      const terminal = attempts >= 8;
      const delayMinutes = Math.min(360, 2 ** attempts);
      await this.prisma.partnerWebhookDelivery.update({ where: { id: item.id }, data: {
        status: terminal ? 'FAILED' : 'RETRY', lastError: String(error?.message || error).slice(0, 1000),
        nextAttemptAt: new Date(Date.now() + delayMinutes * 60_000),
      } });
      this.logger.warn(`Webhook ${item.id} falló: ${error?.message || error}`);
    }
  }

  private async find(principal: PartnerPrincipal, id: string) {
    const endpoint = await this.prisma.partnerWebhookEndpoint.findFirst({
      where: { id, workspaceId: principal.workspaceId, apiClientId: principal.apiClientId },
    });
    if (!endpoint) throw new NotFoundException('Endpoint webhook no encontrado');
    return endpoint;
  }

  private encrypt(value: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return `${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`;
  }

  private decrypt(value: string) {
    const [iv, tag, encrypted] = value.split('.').map(part => Buffer.from(part, 'base64url'));
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  }

  private async assertPublicHttps(value: string) {
    let url: URL;
    try { url = new URL(value); } catch { throw new BadRequestException('URL webhook inválida'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.port) throw new BadRequestException('El webhook debe usar HTTPS estándar');
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) throw new BadRequestException('El webhook debe usar un host público');
    const addresses = await lookup(url.hostname, { all: true }).catch(() => []);
    if (!addresses.length || addresses.some(item => this.privateAddress(item.address))) throw new BadRequestException('El webhook debe resolver a una dirección pública');
  }

  private privateAddress(address: string) {
    if (!isIP(address)) return true;
    const normalized = address.toLowerCase();
    if (normalized.startsWith('::ffff:')) return this.privateAddress(normalized.slice(7));
    if (normalized.includes(':')) {
      return normalized === '::' || normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd')
        || /^fe[89ab]/.test(normalized) || normalized.startsWith('ff');
    }
    const octets = normalized.split('.').map(Number);
    return octets[0] === 0 || octets[0] === 10 || octets[0] === 127 || octets[0] >= 224
      || (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127)
      || (octets[0] === 169 && octets[1] === 254)
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 192 && octets[1] === 168)
      || (octets[0] === 198 && (octets[1] === 18 || octets[1] === 19));
  }
}
