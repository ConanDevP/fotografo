import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import { randomBytes } from 'crypto';

import { UsersService } from '../users/users.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { AuthTokens, UserProfile, UserRole } from '@shared/types';
import { ERROR_CODES } from '@shared/constants';

@Injectable()
export class AuthService {
  private refreshTokens = new Map<string, { userId: string; expiresAt: number }>();

  constructor(
    private usersService: UsersService,
    private jwtService: JwtService,
    private configService: ConfigService,
  ) {}

  async register(registerDto: RegisterDto): Promise<{ tokens: AuthTokens; user: UserProfile }> {
    const { email, password, role = UserRole.ATHLETE } = registerDto;

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
      role,
    });

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

    const tokens = await this.generateTokens(user.id);
    return {
      tokens,
      user: this.mapUserToProfile(user),
    };
  }

  async refresh(refreshToken: string): Promise<{ accessToken: string }> {
    const tokenData = this.refreshTokens.get(refreshToken);
    
    if (!tokenData || Date.now() > tokenData.expiresAt) {
      this.refreshTokens.delete(refreshToken);
      throw new UnauthorizedException({
        code: ERROR_CODES.TOKEN_EXPIRED,
        message: 'Token de refresh expirado',
      });
    }

    const user = await this.usersService.findById(tokenData.userId);
    if (!user) {
      this.refreshTokens.delete(refreshToken);
      throw new UnauthorizedException({
        code: ERROR_CODES.USER_NOT_FOUND,
        message: 'Usuario no encontrado',
      });
    }

    const accessToken = this.jwtService.sign({ 
      sub: user.id, 
      email: user.email, 
      role: user.role 
    });

    return { accessToken };
  }

  async logout(refreshToken: string): Promise<void> {
    this.refreshTokens.delete(refreshToken);
  }

  async validateUser(email: string, password: string): Promise<any> {
    const user = await this.usersService.findByEmail(email);
    
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

    this.refreshTokens.set(refreshToken, { userId, expiresAt });

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

  private mapUserToProfile(user: any): UserProfile {
    return {
      id: user.id,
      email: user.email,
      role: user.role,
      createdAt: user.createdAt.toISOString(),
    };
  }
}