import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * Cuenta las peticiones por usuario autenticado en lugar de por IP.
 *
 * Con el seguimiento por IP, dos fotógrafos cubriendo la misma carrera desde el
 * wifi del evento comparten el mismo cupo y se bloquean entre ellos. Como el
 * identificador de usuario viene de un JWT firmado, no es falsificable, así que
 * es mejor tracker que la IP siempre que haya sesión.
 */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  protected getTracker(req: Record<string, any>): string {
    const userId = req?.user?.id;
    return userId ? `user:${userId}` : `ip:${req.ip}`;
  }
}
