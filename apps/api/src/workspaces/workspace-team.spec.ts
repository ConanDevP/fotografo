import { ForbiddenException } from '@nestjs/common';
import { WorkspacesService } from './workspaces.service';

function build(opts: { maxAdmins?: number | null; admins?: number; user?: any; member?: any; invitation?: any } = {}) {
  const prisma: any = {
    workspaceMember: {
      findFirst: jest.fn().mockImplementation(async (args: any) => (args?.where?.id ? opts.member ?? null : { id: 'self', role: 'OWNER', status: 'ACTIVE', workspace: { deletedAt: null } })),
      count: jest.fn().mockResolvedValue(opts.admins ?? 0),
      upsert: jest.fn().mockResolvedValue({ role: 'ADMIN' }),
      update: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue({}),
    },
    user: { findUnique: jest.fn().mockResolvedValue(opts.user ?? null) },
    workspace: { findUnique: jest.fn().mockResolvedValue({ name: 'Cronos' }) },
    workspaceInvitation: {
      upsert: jest.fn().mockImplementation(async (a: any) => ({ id: 'inv', ...a.create })),
      findUnique: jest.fn().mockResolvedValue(opts.invitation ?? null),
      update: jest.fn().mockResolvedValue({}),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn().mockImplementation(async (ops: any[]) => Promise.all(ops)),
  };
  const billing: any = { maxAdminsFor: jest.fn().mockResolvedValue(opts.maxAdmins ?? null) };
  const mailer: any = { send: jest.fn().mockResolvedValue(true) };
  const service = new WorkspacesService(prisma, {} as any, {} as any, billing, {} as any, mailer);
  return { service, prisma, mailer };
}

describe('equipo del espacio', () => {
  it('subir a administrador respeta el límite del plan', async () => {
    const { service } = build({ maxAdmins: 1, admins: 1, member: { id: 'm', userId: 'u2', role: 'EDITOR', status: 'ACTIVE' } });
    await expect(service.updateMember('ws', 'm', { role: 'ADMIN' } as any, 'self')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('reactivar a un administrador suspendido también ocupa un puesto', async () => {
    const { service } = build({ maxAdmins: 1, admins: 1, member: { id: 'm', userId: 'u2', role: 'ADMIN', status: 'SUSPENDED' } });
    await expect(service.updateMember('ws', 'm', { status: 'ACTIVE' } as any, 'self')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('cambiar un rol que no administra no consume puesto', async () => {
    const { service, prisma } = build({ maxAdmins: 1, admins: 1, member: { id: 'm', userId: 'u2', role: 'EDITOR', status: 'ACTIVE' } });
    await service.updateMember('ws', 'm', { role: 'ANALYST' } as any, 'self');
    expect(prisma.workspaceMember.update).toHaveBeenCalled();
  });

  it('volver a añadir a quien ya es administrador no se cuenta dos veces', async () => {
    const { service, prisma } = build({ maxAdmins: 1, admins: 0, user: { id: 'u2' } });
    await service.addMember('ws', { email: 'A@x.com', role: 'ADMIN' } as any, 'self');
    expect(prisma.workspaceMember.count).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ userId: { not: 'u2' } }) }));
    expect(prisma.workspaceMember.upsert).toHaveBeenCalled();
  });

  it('si el correo no tiene cuenta, crea una invitación y manda el enlace', async () => {
    const { service, prisma, mailer } = build({ user: null });
    const result: any = await service.addMember('ws', { email: ' Nuevo@X.com ', role: 'EDITOR' } as any, 'self');
    expect(result.invited).toBe(true);
    expect(prisma.workspaceInvitation.upsert).toHaveBeenCalled();
    expect(mailer.send).toHaveBeenCalledWith(expect.objectContaining({ to: 'nuevo@x.com' }));
    expect(result.invitation.tokenHash).toBeUndefined();
  });

  it('no se puede quitar al propietario ni a uno mismo', async () => {
    const owner = build({ member: { id: 'm', userId: 'u2', role: 'OWNER' } });
    await expect(owner.service.removeMember('ws', 'm', 'self')).rejects.toThrow();
    const me = build({ member: { id: 'm', userId: 'self', role: 'ADMIN' } });
    await expect(me.service.removeMember('ws', 'm', 'self')).rejects.toThrow();
  });

  it('quitar a un miembro lo borra y deja auditoría', async () => {
    const { service, prisma } = build({ member: { id: 'm', userId: 'u2', role: 'EDITOR' } });
    await service.removeMember('ws', 'm', 'self');
    expect(prisma.workspaceMember.delete).toHaveBeenCalledWith({ where: { id: 'm' } });
    expect(prisma.auditLog.create).toHaveBeenCalled();
  });

  it('una invitación solo la acepta la cuenta del correo invitado', async () => {
    const invitation = { id: 'i', workspaceId: 'ws', email: 'a@x.com', role: 'EDITOR', status: 'PENDING', expiresAt: new Date(Date.now() + 1e6) };
    const { service, prisma } = build({ invitation });
    prisma.user.findUnique.mockResolvedValue({ email: 'otro@x.com' });
    await expect(service.acceptInvitation('tok', 'u9')).rejects.toBeInstanceOf(ForbiddenException);
    prisma.user.findUnique.mockResolvedValue({ email: 'A@x.com' });
    await expect(service.acceptInvitation('tok', 'u9')).resolves.toMatchObject({ workspaceId: 'ws' });
  });

  it('una invitación caducada no sirve', async () => {
    const { service } = build({ invitation: { id: 'i', workspaceId: 'ws', email: 'a@x.com', role: 'EDITOR', status: 'PENDING', expiresAt: new Date(Date.now() - 1000) } });
    await expect(service.getInvitation('tok')).rejects.toThrow();
  });
});
