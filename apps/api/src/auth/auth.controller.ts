import { Controller, Post, Body, UseGuards, Req, HttpCode, HttpStatus } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Request } from 'express';

import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { ApiResponse } from '@shared/types';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

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
}