import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import Stripe from 'stripe';

import { PrismaService } from '../common/services/prisma.service';

/**
 * Cierre de cuenta a petición del titular.
 *
 * No se borra la fila del usuario, y no por comodidad: los apuntes contables,
 * los pedidos y el registro de auditoría apuntan a ella, y conservar esos
 * registros es una obligación fiscal. El RGPD contempla justamente eso — el
 * derecho de supresión cede ante una obligación legal de conservación y ante
 * la defensa de reclamaciones (art. 17.3).
 *
 * Lo que sí desaparece es la persona: nombre, correo, teléfono, contraseña y
 * datos de cobro. Queda una fila anónima que sostiene la contabilidad y no
 * identifica a nadie, y una marca que cierra el acceso de forma explícita.
 *
 * Lo público se retira: espacios y eventos dejan de ser visibles. Los ficheros
 * no se destruyen aquí a propósito — hay compradores que pagaron por ellos.
 * Para borrarlos está el borrado de eventos, que ya comprueba si hubo ventas.
 */
@Injectable()
export class AccountDeletionService {
  private readonly logger = new Logger(AccountDeletionService.name);
  private readonly stripe: Stripe | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    const key = this.config.get<string>('STRIPE_SECRET_KEY');
    this.stripe = key ? new Stripe(key, { apiVersion: '2022-11-15' }) : null;
  }

  /**
   * Cuánto se le debe todavía al titular.
   *
   * Se comprueba antes de cerrar porque cerrar con dinero pendiente lo dejaría
   * sin destinatario: los apuntes seguirían ahí, pero ya no habría a quién
   * transferirlos ni cuenta desde la que reclamarlo.
   */
  private async pendingEarningsCents(userId: string): Promise<number> {
    const pending = await this.prisma.ledgerEntry.aggregate({
      where: {
        beneficiaryUserId: userId,
        type: { in: ['PHOTOGRAPHER_EARNING', 'ORGANIZER_COMMISSION'] },
        status: { in: ['PENDING', 'AVAILABLE'] },
      },
      _sum: { amountCents: true },
    });
    return pending._sum.amountCents ?? 0;
  }

  /**
   * Corta el cobro recurrente antes de cerrar.
   *
   * Sin esto, alguien podría cerrar su cuenta y seguir viendo cargos mensuales
   * sin ningún sitio donde pararlos. Se cancela de inmediato, no al final del
   * periodo: quien se va no debería pagar un mes más.
   */
  private async cancelSubscriptions(workspaceIds: string[]): Promise<number> {
    if (!this.stripe || workspaceIds.length === 0) return 0;

    const subscriptions = await this.prisma.subscription.findMany({
      where: { workspaceId: { in: workspaceIds }, stripeSubscriptionId: { not: null } },
      select: { id: true, stripeSubscriptionId: true },
    });

    let cancelled = 0;
    for (const subscription of subscriptions) {
      try {
        await this.stripe.subscriptions.del(subscription.stripeSubscriptionId!);
        cancelled += 1;
      } catch (error) {
        // Ya cancelada o inexistente en la pasarela: el cierre sigue. Bloquear
        // aquí dejaría al titular atrapado por un objeto que ya no existe.
        this.logger.warn(
          `No se pudo cancelar ${subscription.stripeSubscriptionId}: ${error instanceof Error ? error.message : 'error desconocido'}`,
        );
      }
      await this.prisma.subscription.update({
        where: { id: subscription.id },
        data: { status: 'CANCELED' },
      });
    }
    return cancelled;
  }

  /**
   * Cierra la cuenta. Exige la contraseña actual: es una acción irreversible y
   * una sesión abierta en un ordenador ajeno no debería bastar para ejecutarla.
   */
  async deleteOwnAccount(userId: string, password: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, passwordHash: true, deletedAt: true },
    });
    if (!user) throw new NotFoundException('Cuenta no encontrada');
    if (user.deletedAt) throw new BadRequestException('Esta cuenta ya está cerrada');

    if (!user.passwordHash || !(await argon2.verify(user.passwordHash, password))) {
      throw new ForbiddenException('La contraseña no es correcta');
    }

    const pendingCents = await this.pendingEarningsCents(userId);
    if (pendingCents > 0) {
      throw new BadRequestException({
        code: 'PENDING_EARNINGS',
        message:
          `Tienes ${(pendingCents / 100).toFixed(2)} US$ pendientes de transferir. ` +
          'Cobra ese saldo antes de cerrar la cuenta: al cerrarla dejaría de haber destinatario.',
      });
    }

    const workspaces = await this.prisma.workspace.findMany({
      where: { ownerId: userId, deletedAt: null },
      select: { id: true },
    });
    const workspaceIds = workspaces.map(workspace => workspace.id);

    const cancelledSubscriptions = await this.cancelSubscriptions(workspaceIds);

    const closedAt = new Date();
    // Correo irrepetible y de dominio reservado por la norma para ejemplos:
    // nunca podrá pertenecer a nadie ni recibir correo. La columna es única, y
    // reutilizar el original impediría que esa persona vuelva a registrarse.
    const anonymousEmail = `cuenta-cerrada-${user.id}@invalid`;

    await this.prisma.$transaction(async tx => {
      if (workspaceIds.length > 0) {
        await tx.workspace.updateMany({
          where: { id: { in: workspaceIds } },
          data: { isPublished: false, deletedAt: closedAt },
        });
        await tx.event.updateMany({
          where: { workspaceId: { in: workspaceIds }, deletedAt: null },
          data: { isPublished: false, deletedAt: closedAt },
        });
      }

      // Los enlaces de recuperación vivos permitirían volver a entrar.
      await tx.passwordResetToken.deleteMany({ where: { userId } });

      await tx.user.update({
        where: { id: userId },
        data: {
          deletedAt: closedAt,
          email: anonymousEmail,
          name: null,
          phone: null,
          passwordHash: null,
          paypalEmail: null,
          // La cuenta de cobros queda desligada: es un dato de un tercero
          // (la pasarela) asociado a una persona que ya no está aquí.
          stripeAccountId: null,
          stripeAccountStatus: null,
          stripeOnboardingCompleted: false,
          stripeChargesEnabled: false,
          stripePayoutsEnabled: false,
        },
      });

      // Sin datos personales: es la prueba de que el cierre ocurrió y cuándo,
      // que es justamente lo que hay que poder demostrar si alguien reclama.
      await tx.auditLog.create({
        data: {
          userId,
          action: 'ACCOUNT_CLOSED_BY_OWNER',
          data: {
            closedAt: closedAt.toISOString(),
            workspaces: workspaceIds.length,
            cancelledSubscriptions,
          },
        },
      });
    });

    this.logger.log(`Cuenta ${userId} cerrada a petición del titular`);

    return {
      message: 'Tu cuenta quedó cerrada.',
      workspacesHidden: workspaceIds.length,
      cancelledSubscriptions,
    };
  }
}
