import { ExtractJwt, Strategy } from 'passport-jwt';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { UsersService } from '../../users/users.service';
import { ERROR_CODES } from '@shared/constants';
import { normalizePem } from '../../common/config/validate-environment';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private configService: ConfigService,
    private usersService: UsersService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: normalizePem(configService.get('JWT_PUBLIC_KEY')),
      algorithms: ['RS256'],
    });
  }

  async validate(payload: any) {
    const user = await this.usersService.findById(payload.sub);
    
    if (!user) {
      throw new UnauthorizedException({
        code: ERROR_CODES.USER_NOT_FOUND,
        message: 'Usuario no encontrado',
      });
    }

    // Una cuenta cerrada conserva su fila para sostener la contabilidad, pero
    // no debe poder entrar. Sin esta comprobación, los tokens emitidos antes
    // del cierre seguirían siendo válidos hasta caducar.
    if (user.deletedAt) {
      throw new UnauthorizedException({
        code: ERROR_CODES.UNAUTHORIZED,
        message: 'Esta cuenta está cerrada',
      });
    }

    return {
      id: user.id,
      email: user.email,
      role: user.role,
    };
  }
}
