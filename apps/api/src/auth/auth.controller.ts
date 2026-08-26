import { Controller, Post, Body, UseGuards, Req, Res, HttpCode, HttpStatus, Put, Get, UploadedFile, UseInterceptors, BadRequestException, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { FileInterceptor } from '@nestjs/platform-express';
import { Request, Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import { timingSafeEqual } from 'crypto';

import { AuthService } from './auth.service';
import { UsersService } from '../users/users.service';
import { StorageService } from '../common/services/storage.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { CreateAdminDto } from './dto/create-admin.dto';
import { ForgotPasswordDto, ResetPasswordWithTokenDto } from './dto/password-reset.dto';
import { PasswordResetService } from './password-reset.service';
import { ApiResponse } from '@shared/types';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly usersService: UsersService,
    private readonly storageService: StorageService,
    private readonly passwordReset: PasswordResetService,
  ) {}

  @Post('register')
  @Throttle(5, 60)
  async register(
    @Body() registerDto: RegisterDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApiResponse> {
    const result = await this.authService.register(registerDto);
    return { data: this.establishBrowserSession(res, result) };
  }

  /** Siempre responde igual, exista la cuenta o no: si no, delataría quién está registrado. */
  @Post('forgot-password')
  @Throttle(5, 900)
  async forgotPassword(@Body() dto: ForgotPasswordDto): Promise<ApiResponse> {
    return { data: await this.passwordReset.request(dto.email) };
  }

  @Post('reset-password')
  @Throttle(5, 900)
  async resetPassword(@Body() dto: ResetPasswordWithTokenDto): Promise<ApiResponse> {
    return { data: await this.passwordReset.reset(dto.token, dto.password) };
  }

  @Post('login')
  @Throttle(10, 60)
  @HttpCode(HttpStatus.OK)
  async login(
    @Req() req: Request,
    @Body() loginDto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApiResponse> {
    const result = await this.authService.login(loginDto);
    return { data: this.establishBrowserSession(res, result) };
  }

  @Post('refresh')
  @Throttle(30, 60)
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Req() req: Request,
    @Body() refreshTokenDto: RefreshTokenDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ApiResponse> {
    const refreshToken = refreshTokenDto.refreshToken || this.readRefreshCookie(req);
    if (!refreshToken) throw new UnauthorizedException('Sesión no disponible');
    const tokens = await this.authService.refresh(refreshToken);
    this.writeRefreshCookie(res, tokens.refreshToken);
    return { data: { accessToken: tokens.accessToken } };
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @Req() req: Request,
    @Body() refreshTokenDto: RefreshTokenDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const refreshToken = refreshTokenDto.refreshToken || this.readRefreshCookie(req);
    if (refreshToken) await this.authService.logout(refreshToken);
    res.clearCookie('lucilamon_refresh', this.refreshCookieOptions());
  }

  @UseGuards(AuthGuard('jwt'))
  @Get('profile')
  async getProfile(@Req() req: any): Promise<ApiResponse> {
    const user = await this.usersService.findById(req.user.id);
    return { 
      data: this.authService['mapUserToProfile'](user)
    };
  }

  @UseGuards(AuthGuard('jwt'))
  @Put('profile')
  async updateProfile(
    @Req() req: any, 
    @Body() updateProfileDto: UpdateProfileDto
  ): Promise<ApiResponse> {
    const updatedUser = await this.usersService.update(req.user.id, updateProfileDto);
    return { 
      data: this.authService['mapUserToProfile'](updatedUser)
    };
  }

  @UseGuards(AuthGuard('jwt'))
  @Post('profile/avatar')
  @Throttle(10, 60)
  @UseInterceptors(FileInterceptor('avatar', {
    limits: { fileSize: 2 * 1024 * 1024, files: 1, fields: 5 },
  }))
  async uploadAvatar(
    @Req() req: any,
    @UploadedFile() file: Express.Multer.File
  ): Promise<ApiResponse> {
    if (!file) {
      throw new BadRequestException('No se ha proporcionado archivo');
    }

    // Validar tipo de archivo
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    if (!allowedTypes.includes(file.mimetype)) {
      throw new BadRequestException('Solo se permiten archivos de imagen (JPG, PNG, WEBP)');
    }

    // Validar tamaño (max 2MB)
    const maxSize = 2 * 1024 * 1024;
    if (file.size > maxSize) {
      throw new BadRequestException('El archivo no puede superar los 2MB');
    }
    const bytes = file.buffer;
    const isJpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    const isPng = bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
      .every((value, index) => bytes[index] === value);
    const isWebp = bytes.length >= 12
      && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
      && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
    if (!isJpeg && !isPng && !isWebp) throw new BadRequestException('El contenido no corresponde a una imagen válida');

    try {
      const metadata = await this.storageService.getImageMetadata(file.buffer);
      if (!metadata.width || !metadata.height || metadata.width * metadata.height > 20_000_000) {
        throw new BadRequestException('El avatar excede el límite de 20 megapíxeles');
      }
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException('No se pudieron validar las dimensiones del avatar');
    }

    try {
      // Subir avatar a R2
      const result = await this.storageService.uploadAvatar(file, req.user.id);
      
      // Actualizar URL de avatar en la BD
      const updatedUser = await this.usersService.update(req.user.id, {
        profileImageUrl: result.url
      });

      return { 
        data: {
          user: this.authService['mapUserToProfile'](updatedUser),
          avatar: result
        }
      };
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new BadRequestException(`Error al subir avatar: ${errorMessage}`);
    }
  }

  /**
   * Endpoint especial para crear el primer usuario admin
   * IMPORTANTE: Solo usar en desarrollo o setup inicial
   * Protegido con clave secreta en variables de entorno
   */
  @Post('create-admin')
  @Throttle(3, 60)
  async createAdmin(@Body() createAdminDto: CreateAdminDto): Promise<ApiResponse> {
    const adminSecretKey = process.env.ADMIN_SECRET_KEY;

    if (!adminSecretKey) {
      throw new BadRequestException('La creación inicial de administradores está deshabilitada');
    }

    const providedSecret = Buffer.from(createAdminDto.secretKey);
    const expectedSecret = Buffer.from(adminSecretKey);
    if (providedSecret.length !== expectedSecret.length || !timingSafeEqual(providedSecret, expectedSecret)) {
      throw new BadRequestException('Clave secreta inválida');
    }

    const admin = await this.authService.createInitialAdmin({
      email: createAdminDto.email,
      password: createAdminDto.password,
      name: createAdminDto.name,
    });

    return {
      data: {
        message: 'Usuario administrador creado exitosamente',
        user: {
          id: admin.id,
          email: admin.email,
          name: admin.name,
          role: admin.role,
        },
      },
    };
  }

  private establishBrowserSession(
    res: Response,
    result: { tokens: { accessToken: string; refreshToken: string }; user: unknown },
  ) {
    this.writeRefreshCookie(res, result.tokens.refreshToken);
    return {
      user: result.user,
      tokens: { accessToken: result.tokens.accessToken },
    };
  }

  private writeRefreshCookie(res: Response, refreshToken: string) {
    res.cookie('lucilamon_refresh', refreshToken, {
      ...this.refreshCookieOptions(),
      maxAge: this.authService.refreshTokenTtlMs(),
    });
  }

  private refreshCookieOptions() {
    return {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict' as const,
      path: '/v1/auth',
    };
  }

  private readRefreshCookie(req: Request) {
    const cookie = req.headers.cookie
      ?.split(';')
      .map(item => item.trim().split('='))
      .find(([name]) => name === 'lucilamon_refresh');
    if (!cookie?.[1]) return undefined;
    try {
      return decodeURIComponent(cookie.slice(1).join('='));
    } catch {
      return undefined;
    }
  }
}
