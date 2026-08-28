import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';

import { AccountDeletionService } from './account-deletion.service';
import { PrismaService } from '../common/services/prisma.service';

/**
 * Cerrar una cuenta no se deshace. Estas pruebas fijan las cuatro cosas que no
 * pueden fallar: que no se cierre con dinero pendiente, que deje de cobrarse,
 * que desaparezca la persona pero no la contabilidad, y que nada quede visible.
 */
describe('Cierre de cuenta', () => {
  let service: AccountDeletionService;
  let prisma: any;

  const USER = 'user-1';
  const PASSWORD = 'contraseña-correcta';
  let hash: string;

  beforeAll(async () => {
    hash = await argon2.hash(PASSWORD);
  });

  beforeEach(async () => {
    prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: USER,
          email: 'foto@ejemplo.com',
          passwordHash: hash,
          deletedAt: null,
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      ledgerEntry: { aggregate: jest.fn().mockResolvedValue({ _sum: { amountCents: 0 } }) },
      workspace: {
        findMany: jest.fn().mockResolvedValue([{ id: 'ws-1' }]),
        updateMany: jest.fn().mockResolvedValue({}),
      },
      event: { updateMany: jest.fn().mockResolvedValue({}) },
      subscription: { findMany: jest.fn().mockResolvedValue([]), update: jest.fn().mockResolvedValue({}) },
      passwordResetToken: { deleteMany: jest.fn().mockResolvedValue({}) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
      $transaction: jest.fn().mockImplementation(async (fn: any) => fn(prisma)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AccountDeletionService,
        { provide: PrismaService, useValue: prisma },
        // Sin clave de Stripe: la cancelación se omite sin romper el cierre.
        { provide: ConfigService, useValue: { get: () => undefined } },
      ],
    }).compile();

    service = module.get<AccountDeletionService>(AccountDeletionService);
  });

  it('exige la contraseña actual', async () => {
    // Una sesión abierta en un ordenador ajeno no debe bastar para algo
    // irreversible.
    await expect(service.deleteOwnAccount(USER, 'contraseña-equivocada')).rejects.toThrow(
      ForbiddenException,
    );
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('no cierra si todavía se le debe dinero', async () => {
    // Cerrar dejaría los apuntes sin destinatario y a esa persona sin cuenta
    // desde la que reclamar.
    prisma.ledgerEntry.aggregate.mockResolvedValue({ _sum: { amountCents: 4520 } });

    await expect(service.deleteOwnAccount(USER, PASSWORD)).rejects.toThrow(BadRequestException);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('borra los datos personales pero conserva la fila', async () => {
    // La contabilidad y los pedidos apuntan a este usuario y hay obligación
    // legal de conservarlos; lo que desaparece es la persona.
    await service.deleteOwnAccount(USER, PASSWORD);

    const datos = prisma.user.update.mock.calls[0][0].data;
    expect(datos.name).toBeNull();
    expect(datos.phone).toBeNull();
    expect(datos.passwordHash).toBeNull();
    expect(datos.paypalEmail).toBeNull();
    expect(datos.stripeAccountId).toBeNull();
    expect(datos.email).not.toContain('ejemplo.com');
    expect(datos.deletedAt).toBeInstanceOf(Date);
  });

  it('deja un correo que nadie puede recibir ni reutilizar', async () => {
    // La columna es única: conservar el original impediría que esa persona
    // vuelva a registrarse algún día.
    await service.deleteOwnAccount(USER, PASSWORD);

    expect(prisma.user.update.mock.calls[0][0].data.email).toBe(`cuenta-cerrada-${USER}@invalid`);
  });

  it('retira de la vista los espacios y sus eventos', async () => {
    await service.deleteOwnAccount(USER, PASSWORD);

    expect(prisma.workspace.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ isPublished: false }) }),
    );
    expect(prisma.event.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ isPublished: false }) }),
    );
  });

  it('invalida los enlaces de recuperación vivos', async () => {
    // Si no, un correo anterior permitiría volver a entrar en la cuenta cerrada.
    await service.deleteOwnAccount(USER, PASSWORD);

    expect(prisma.passwordResetToken.deleteMany).toHaveBeenCalledWith({ where: { userId: USER } });
  });

  it('deja constancia del cierre sin datos personales', async () => {
    await service.deleteOwnAccount(USER, PASSWORD);

    const registro = prisma.auditLog.create.mock.calls[0][0].data;
    expect(registro.action).toBe('ACCOUNT_CLOSED_BY_OWNER');
    expect(JSON.stringify(registro.data)).not.toContain('ejemplo.com');
  });

  it('no cierra dos veces la misma cuenta', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: USER,
      email: 'x@invalid',
      passwordHash: hash,
      deletedAt: new Date(),
    });

    await expect(service.deleteOwnAccount(USER, PASSWORD)).rejects.toThrow(BadRequestException);
  });
});
