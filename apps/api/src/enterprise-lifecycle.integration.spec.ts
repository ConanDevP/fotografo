/**
 * Ciclo de vida del cliente Enterprise contra PostgreSQL real: piloto, claves de prueba,
 * activación, prioridad, retención y equipo. Mismas reglas que enterprise.integration.spec.ts:
 * solo corre con E2E_DATABASE_URL y nunca debe apuntar a una base con datos.
 */
import { PrismaClient } from '@prisma/client';
import { ForbiddenException } from '@nestjs/common';
import { AdminEnterpriseService } from './admin/admin-enterprise.service';
import { PILOT_PRESET } from './admin/enterprise-pilot.preset';
import { ApiClientsService } from './partner-api/api-clients.service';
import { EnterpriseAccessService } from './partner-api/enterprise-access.service';
import { MeteringService } from './billing/metering.service';
import { ProcessingPriorityService, PROCESSING_PRIORITY } from './billing/processing-priority.service';
import { DataRetentionService } from './partner-api/data-retention.service';
import { EventsService } from './events/events.service';
import { WorkspacesService } from './workspaces/workspaces.service';

import { e2eDatabaseUrl } from './test-support/e2e-db';

const url = e2eDatabaseUrl();
const suite = url ? describe : describe.skip;
const stamp = Date.now();
const DAY = 24 * 3600 * 1000;

suite('ciclo de vida Enterprise contra PostgreSQL real', () => {
  let prisma: any;
  let adminId: string;
  let ownerId: string;
  let workspaceId: string;

  const newWorkspace = async (label: string) => {
    const owner = await prisma.user.create({ data: { email: `${label}-${stamp}@e2e.test`, role: 'PHOTOGRAPHER' } });
    const ws = await prisma.workspace.create({ data: { name: label, slug: `${label}-${stamp}`, ownerId: owner.id } });
    await prisma.workspaceMember.create({ data: { workspaceId: ws.id, userId: owner.id, role: 'OWNER' } });
    return { owner, ws };
  };

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url } } });
    adminId = (await prisma.user.create({ data: { email: `admin-${stamp}@e2e.test`, role: 'ADMIN' } })).id;
    const { owner, ws } = await newWorkspace('piloto');
    ownerId = owner.id;
    workspaceId = ws.id;
  });

  afterAll(async () => { await prisma?.$disconnect(); });

  describe('piloto y claves de prueba', () => {
    it('abrir el piloto crea la cuenta con los topes del preset y deja auditoría', async () => {
      const account = await new AdminEnterpriseService(prisma).startPilot(workspaceId, adminId);
      expect(account).toMatchObject({
        status: 'PILOT',
        annualPhotoLimit: PILOT_PRESET.account.annualPhotoLimit,
        annualEventLimit: PILOT_PRESET.account.annualEventLimit,
        maxApiClients: PILOT_PRESET.account.maxApiClients,
      });
      expect(account.contractEnd.getTime() - account.contractStart.getTime()).toBeCloseTo(PILOT_PRESET.days * DAY, -5);
      expect(await prisma.auditLog.count({ where: { action: 'ENTERPRISE_PILOT_STARTED', data: { path: ['workspaceId'], equals: workspaceId } } })).toBe(1);
    });

    it('las claves nacen de prueba y respetan el máximo de credenciales del piloto', async () => {
      const access = new EnterpriseAccessService(prisma, { get: jest.fn() } as any);
      const workspaces: any = { assertAccess: jest.fn().mockResolvedValue(undefined) };
      const clients = new ApiClientsService(prisma, workspaces, access);
      const scopes = ['events:read'];
      const first: any = await clients.create(workspaceId, ownerId, { name: 'Sistema A', scopes } as any);
      expect(first.apiKey.startsWith('lm_test_')).toBe(true);
      expect(first.environment).toBe('TEST');
      await clients.create(workspaceId, ownerId, { name: 'Sistema B', scopes } as any);
      await expect(clients.create(workspaceId, ownerId, { name: 'Sistema C', scopes } as any)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('el piloto limita los eventos y las fotos a los topes pactados', async () => {
      const metering = new MeteringService(prisma);
      for (let i = 0; i < PILOT_PRESET.account.annualEventLimit; i++) {
        await metering.assertEventCapacity(workspaceId);
        await prisma.event.create({ data: { name: `Piloto ${i}`, slug: `piloto-${stamp}-${i}`, date: new Date(), ownerId, workspaceId } });
      }
      await expect(metering.assertEventCapacity(workspaceId)).rejects.toMatchObject({ response: expect.objectContaining({ code: 'EVENT_LIMIT_REACHED' }) });
      const allowance = await metering.photoAllowance(workspaceId);
      expect(allowance).toMatchObject({ enforced: true, limit: PILOT_PRESET.account.annualPhotoLimit });
      await expect(metering.assertPhotoCapacity(workspaceId, PILOT_PRESET.account.annualPhotoLimit + 1)).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'PHOTO_LIMIT_REACHED' }),
      });
    });

    it('al activar el contrato las claves de prueba dejan de valer y las de producción sí', async () => {
      const access = new EnterpriseAccessService(prisma, { get: jest.fn() } as any);
      await access.authorizeExistingClient(workspaceId, ['events:read'], ['events:read'], 'TEST');
      await prisma.enterpriseAccount.update({ where: { workspaceId }, data: { status: 'ACTIVE', contractStart: new Date(Date.now() - DAY), contractEnd: new Date(Date.now() + 300 * DAY) } });
      await expect(access.authorizeExistingClient(workspaceId, ['events:read'], ['events:read'], 'TEST')).rejects.toBeInstanceOf(ForbiddenException);
      await expect(access.authorizeExistingClient(workspaceId, ['events:read'], ['events:read'], 'LIVE')).resolves.toBeUndefined();
    });

    it('no se puede abrir un piloto sobre un contrato ya activo', async () => {
      await expect(new AdminEnterpriseService(prisma).startPilot(workspaceId, adminId)).rejects.toThrow();
    });
  });

  describe('prioridad de procesamiento', () => {
    it('solo el contrato vigente con prioridad adelanta a los demás', async () => {
      const priority = new ProcessingPriorityService(prisma);
      const { ws: free } = await newWorkspace('sin-contrato');
      const { ws: vip } = await newWorkspace('prioritario');
      const { ws: lapsed } = await newWorkspace('vencido');
      const base = { status: 'ACTIVE', priorityProcessingEnabled: true, contractStart: new Date(Date.now() - 10 * DAY) };
      await prisma.enterpriseAccount.create({ data: { workspaceId: vip.id, ...base, contractEnd: new Date(Date.now() + 30 * DAY) } });
      await prisma.enterpriseAccount.create({ data: { workspaceId: lapsed.id, ...base, contractEnd: new Date(Date.now() - DAY) } });

      expect(await priority.forWorkspace(vip.id)).toBe(PROCESSING_PRIORITY.PRIORITY);
      expect(await priority.forWorkspace(lapsed.id)).toBe(PROCESSING_PRIORITY.NORMAL);
      expect(await priority.forWorkspace(free.id)).toBe(PROCESSING_PRIORITY.NORMAL);
      expect(PROCESSING_PRIORITY.PRIORITY).toBeLessThan(PROCESSING_PRIORITY.NORMAL);
    });
  });

  describe('retención de datos', () => {
    let retentionWs: string;
    let retentionOwner: string;
    let oldFree: string;
    let oldSold: string;
    let recent: string;
    const storage: any = { deleteEventObjects: jest.fn().mockResolvedValue({ deleted: 2, failed: 0 }) };
    const billing: any = { releaseStorage: jest.fn().mockResolvedValue(undefined) };

    beforeAll(async () => {
      const { owner, ws } = await newWorkspace('retencion');
      retentionWs = ws.id;
      retentionOwner = owner.id;
      await prisma.enterpriseAccount.create({ data: { workspaceId: retentionWs, status: 'ACTIVE', retentionDays: 30, contractStart: new Date(Date.now() - 100 * DAY), contractEnd: new Date(Date.now() + 200 * DAY) } });
      const mk = async (name: string, ageDays: number) => {
        const event = await prisma.event.create({ data: { name, slug: `${name}-${stamp}`, date: new Date(Date.now() - ageDays * DAY), ownerId: retentionOwner, workspaceId: retentionWs } });
        await prisma.photo.create({ data: { eventId: event.id, photographerWorkspaceId: retentionWs, cloudinaryId: `${name}-1`, originalUrl: `r2://${name}/1`, originalBytes: 1000, derivedBytes: 200 } });
        return event.id;
      };
      oldFree = await mk('antiguo-gratis', 90);
      oldSold = await mk('antiguo-vendido', 90);
      recent = await mk('reciente', 5);
      await prisma.order.create({ data: { eventId: oldSold, amountCents: 800, status: 'PAID' } });
    });

    const service = () => {
      const events = new EventsService(prisma, storage, {} as any, {} as any, billing, {} as any);
      return new DataRetentionService(prisma, events);
    };

    it('sin RETENTION_ENFORCE solo simula: no borra nada y lo deja en auditoría', async () => {
      delete process.env.RETENTION_ENFORCE;
      const result = await service().run();
      expect(result.purged).toBe(0);
      expect(result.simulated).toBeGreaterThanOrEqual(1);
      expect(await prisma.event.count({ where: { id: oldFree } })).toBe(1);
      const logged = await prisma.auditLog.findMany({ where: { action: 'RETENTION_DRY_RUN', data: { path: ['workspaceId'], equals: retentionWs } } });
      expect(logged).toHaveLength(1);
      expect(logged[0].data.events.map((e: any) => e.id)).toEqual([oldFree]); // el vendido no aparece
    });

    it('con RETENTION_ENFORCE borra el evento vencido sin ventas y respeta el vendido y el reciente', async () => {
      process.env.RETENTION_ENFORCE = 'true';
      try {
        await service().run();
      } finally {
        delete process.env.RETENTION_ENFORCE;
      }
      expect(await prisma.event.count({ where: { id: oldFree } })).toBe(0);
      expect(await prisma.photo.count({ where: { eventId: oldFree } })).toBe(0);
      expect(await prisma.event.count({ where: { id: oldSold } })).toBe(1);
      expect(await prisma.event.count({ where: { id: recent } })).toBe(1);
      expect(storage.deleteEventObjects).toHaveBeenCalledWith(oldFree);
      expect(billing.releaseStorage).toHaveBeenCalledWith(retentionWs, 1200, expect.anything());
    });
  });

  describe('equipo del espacio', () => {
    let teamWs: string;
    let teamOwner: string;
    const billing: any = { maxAdminsFor: jest.fn().mockResolvedValue(2) };
    const mailer: any = { send: jest.fn().mockResolvedValue(true) };
    const svc = () => new WorkspacesService(prisma, {} as any, {} as any, billing, {} as any, mailer);

    beforeAll(async () => {
      const { owner, ws } = await newWorkspace('equipo');
      teamWs = ws.id;
      teamOwner = owner.id;
    });

    it('invita a alguien sin cuenta y solo acepta la cuenta con ese correo', async () => {
      const email = `nuevo-${stamp}@e2e.test`;
      const result: any = await svc().addMember(teamWs, { email, role: 'EDITOR' } as any, teamOwner);
      expect(result.invited).toBe(true);
      const token = new URL(result.acceptanceUrl).hash.replace('#', '').split('=')[1];
      expect(token).toHaveLength(64);

      const stored = await prisma.workspaceInvitation.findFirst({ where: { workspaceId: teamWs, email } });
      expect(stored.tokenHash).not.toBe(token); // solo se guarda el hash

      const impostor = await prisma.user.create({ data: { email: `otro-${stamp}@e2e.test`, role: 'PHOTOGRAPHER' } });
      await expect(svc().acceptInvitation(token, impostor.id)).rejects.toBeInstanceOf(ForbiddenException);

      const invited = await prisma.user.create({ data: { email: email.toUpperCase(), role: 'PHOTOGRAPHER' } });
      await expect(svc().acceptInvitation(token, invited.id)).resolves.toMatchObject({ workspaceId: teamWs, role: 'EDITOR' });
      expect(await prisma.workspaceMember.count({ where: { workspaceId: teamWs, userId: invited.id, status: 'ACTIVE' } })).toBe(1);
      await expect(svc().acceptInvitation(token, invited.id)).rejects.toThrow(); // un solo uso
    });

    it('el límite de administradores se respeta al añadir y al promover', async () => {
      const make = (n: string) => prisma.user.create({ data: { email: `${n}-${stamp}@e2e.test`, role: 'PHOTOGRAPHER' } });
      const admin = await make('admin2');
      const editor = await make('editor2');
      await svc().addMember(teamWs, { email: admin.email, role: 'ADMIN' } as any, teamOwner); // propietario + 1 = 2 de 2
      const added: any = await svc().addMember(teamWs, { email: editor.email, role: 'EDITOR' } as any, teamOwner);
      await expect(svc().updateMember(teamWs, added.id, { role: 'ADMIN' } as any, teamOwner)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(svc().addMember(teamWs, { email: `x-${stamp}@e2e.test`, role: 'ADMIN' } as any, teamOwner)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('quitar a un miembro lo borra de verdad y no deja quitar al propietario', async () => {
      const member = await prisma.workspaceMember.findFirst({ where: { workspaceId: teamWs, role: 'EDITOR' } });
      await svc().removeMember(teamWs, member.id, teamOwner);
      expect(await prisma.workspaceMember.count({ where: { id: member.id } })).toBe(0);
      const owner = await prisma.workspaceMember.findFirst({ where: { workspaceId: teamWs, role: 'OWNER' } });
      await expect(svc().removeMember(teamWs, owner.id, teamOwner)).rejects.toThrow();
    });
  });
});
