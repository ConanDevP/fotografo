import { Body, Controller, Get, Headers, Param, Post, Query, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';

import { RegistrationsService } from './registrations.service';
import { RegisterRunnerDto } from './dto/register-runner.dto';
import { RATE_LIMITS } from '@shared/constants';

/**
 * Páginas que abre el corredor desde el QR o desde su correo. Sin cuenta.
 * El límite del POST es alto a propósito: en la meta cientos de corredores
 * comparten la misma conexión y el límite por IP los bloquearía.
 */
@Controller('public/registrations')
export class RegistrationsPublicController {
  constructor(private readonly registrations: RegistrationsService) {}

  @Get('unsubscribe')
  @Throttle(30, 60)
  async unsubscribeInfo(@Query('t') token: string) {
    return { data: await this.registrations.unsubscribeInfo(token) };
  }

  /** También lo llama el botón "darse de baja" del cliente de correo (RFC 8058). */
  @Post('unsubscribe')
  @Throttle(30, 60)
  async unsubscribe(@Query('t') token: string) {
    return { data: await this.registrations.unsubscribe(token) };
  }

  @Get(':code')
  @Throttle(RATE_LIMITS.REGISTER, 60)
  async get(
    @Param('code') code: string,
    @Headers('cf-ipcountry') cloudflareCountry?: string,
    @Headers('x-vercel-ip-country') vercelCountry?: string,
  ) {
    return { data: await this.registrations.getPublic(code, cloudflareCountry || vercelCountry) };
  }

  @Post(':code')
  @Throttle(RATE_LIMITS.REGISTER, 60)
  async register(@Param('code') code: string, @Body() dto: RegisterRunnerDto, @Req() req: Request) {
    return { data: await this.registrations.register(code, dto, req.ip || '') };
  }
}
