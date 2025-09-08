import { Controller, Post, Body, UseGuards, Req, HttpCode, HttpStatus, Put, Get, UploadedFile, UseInterceptors } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { FileInterceptor } from '@nestjs/platform-express';
import { Request } from 'express';

import { AuthService } from './auth.service';
import { UsersService } from '../users/users.service';
import { R2Service } from '../common/services/r2.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ApiResponse } from '@shared/types';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly usersService: UsersService,
    private readonly r2Service: R2Service,
  ) {}

  @Post('register')
  async register(@Body() registerDto: RegisterDto): Promise<ApiResponse> {
    const result = await this.authService.register(registerDto);
    return { data: result };
  }

  @UseGuards(AuthGuard('local'))
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Req() req: Request, @Body() loginDto: LoginDto): Promise<ApiResponse> {
    const result = await this.authService.login(loginDto);
    return { data: result };
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(@Body() refreshTokenDto: RefreshTokenDto): Promise<ApiResponse> {
    const result = await this.authService.refresh(refreshTokenDto.refreshToken);
    return { data: result };
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Body() refreshTokenDto: RefreshTokenDto): Promise<void> {
    await this.authService.logout(refreshTokenDto.refreshToken);
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
  @UseInterceptors(FileInterceptor('avatar'))
  async uploadAvatar(
    @Req() req: any,
    @UploadedFile() file: Express.Multer.File
  ): Promise<ApiResponse> {
    if (!file) {
      throw new Error('No se ha proporcionado archivo');
    }

    // Validar tipo de archivo
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    if (!allowedTypes.includes(file.mimetype)) {
      throw new Error('Solo se permiten archivos de imagen (JPG, PNG, WEBP)');
    }

    // Validar tamaño (max 2MB)
    const maxSize = 2 * 1024 * 1024;
    if (file.size > maxSize) {
      throw new Error('El archivo no puede superar los 2MB');
    }

    try {
      // Subir avatar a R2
      const result = await this.r2Service.uploadAvatar(file, req.user.id);
      
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
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Error al subir avatar: ${errorMessage}`);
    }
  }
}