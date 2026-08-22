import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import { randomBytes } from 'crypto';

import { UsersService } from '../users/users.service';
import { RedisService } from './redis.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { AuthTokens, UserProfile, UserRole } from '@shared/types';
import { ERROR_CODES } from '@shared/constants';
import { WorkspacesService } from '../workspaces/workspaces.service';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private usersService: UsersService,
    private jwtService: JwtService,
    private configService: ConfigService,
    private redisService: RedisService,
    private workspacesService: WorkspacesService,
  ) {}

  async register(registerDto: RegisterDto): Promise<{ tokens: AuthTokens; user: UserProfile }> {
    const { email, password, name, phone, address, slug, role = UserRole.ATHLETE } = registerDto;

    // Check if user exists
    const existingUser = await this.usersService.findByEmail(email);
    if (existingUser) {
      throw new UnauthorizedException({
        code: ERROR_CODES.EMAIL_ALREADY_EXISTS,
        message: 'El email ya está registrado',
      });
    }

    // Hash password
    const passwordHash = await argon2.hash(password);

    // Create user
    const user = await this.usersService.create({
      email,
      passwordHash,
      name,
      phone,
      address,
      role,
    });

    if (role === UserRole.PHOTOGRAPHER) {
      // El slug pedido en el registro manda sobre el generado desde el nombre.
      await this.ensureProfessionalWorkspace({ ...user, slug: slug ?? user.slug });
    }

    // Generate tokens
    const tokens = await this.generateTokens(user.id);

    return {
      tokens,
      user: this.mapUserToProfile(user),
    };
  }

  async login(loginDto: LoginDto): Promise<{ tokens: AuthTokens; user: UserProfile }> {
    const user = await this.validateUser(loginDto.email, loginDto.password);
    if (!user) {
      throw new UnauthorizedException({
        code: ERROR_CODES.INVALID_CREDENTIALS,
        message: 'Credenciales inválidas',
      });
    }

    await this.ensureProfessionalWorkspace(user);

    const tokens = await this.generateTokens(user.id);
    return {
      tokens,
      user: this.mapUserToProfile(user),
    };
  }

  async refresh(refreshToken: string): Promise<AuthTokens> {
    const tokenData = await this.redisService.consumeRefreshToken(refreshToken);
    
    if (!tokenData || Date.now() > tokenData.expiresAt) {
      throw new UnauthorizedException({
        code: ERROR_CODES.TOKEN_EXPIRED,
        message: 'Token de refresh expirado',
      });
    }

    const user = await this.usersService.findById(tokenData.userId);
    if (!user) {
      throw new UnauthorizedException({
        code: ERROR_CODES.USER_NOT_FOUND,
        message: 'Usuario no encontrado',
      });
    }

    const tokens = await this.generateTokens(user.id);
    return tokens;
  }

  async logout(refreshToken: string): Promise<void> {
    await this.redisService.deleteRefreshToken(refreshToken);
  }

  async validateUser(email: string, password: string): Promise<any> {
    const user = await this.usersService.findByEmail(email.trim().toLowerCase());
    
    if (user && user.passwordHash && await argon2.verify(user.passwordHash, password)) {
      const { passwordHash, ...result } = user;
      return result;
    }
    
    return null;
  }

  private async generateTokens(userId: string): Promise<AuthTokens> {
    const user = await this.usersService.findById(userId);
    
    const accessToken = this.jwtService.sign({
      sub: user.id,
      email: user.email,
      role: user.role,
    });

    const refreshToken = randomBytes(32).toString('hex');
    const expiryTime = this.configService.get('JWT_REFRESH_EXPIRY', '7d');
    const expiresAt = Date.now() + this.parseExpiry(expiryTime);

    await this.redisService.setRefreshToken(refreshToken, userId, expiresAt);

    return { accessToken, refreshToken };
  }

  private parseExpiry(expiry: string): number {
    const unit = expiry.slice(-1);
    const value = parseInt(expiry.slice(0, -1));
    
    switch (unit) {
      case 'm': return value * 60 * 1000;
      case 'h': return value * 60 * 60 * 1000;
      case 'd': return value * 24 * 60 * 60 * 1000;
      default: return 15 * 60 * 1000; // 15 minutes default
    }
  }

  refreshTokenTtlMs(): number {
    return this.parseExpiry(this.configService.get('JWT_REFRESH_EXPIRY', '7d'));
  }

  private mapUserToProfile(user: any): UserProfile {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      phone: user.phone,
      profileImageUrl: user.profileImageUrl,
      address: user.address,
      role: user.role,
      createdAt: user.createdAt.toISOString(),
    };
  }

  /**
   * Método especial para crear usuarios administradores
   * Solo debe usarse en setup inicial o por otros admins
   */
  async createInitialAdmin(data: { email: string; password: string; name: string }) {
    const passwordHash = await argon2.hash(data.password);

    const admin = await this.usersService.createFirstAdmin({
      email: data.email,
      passwordHash,
      name: data.name,
      role: UserRole.ADMIN,
    });

    return admin;
  }

  private async ensureProfessionalWorkspace(user: {
    id: string;
    email: string;
    name?: string | null;
    slug?: string | null;
    role: string;
  }) {
    if (user.role !== UserRole.PHOTOGRAPHER) return;
    try {
      await this.workspacesService.createDefaultForPhotographer(user);
    } catch {
      this.logger.error(`No se pudo asegurar el espacio inicial para ${user.id}`);
    }
  }
}
