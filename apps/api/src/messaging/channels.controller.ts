import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Throttle } from '@nestjs/throttler';

import { ChannelsService } from './channels.service';
import {
  ConfirmTestDto, ConnectEmailDto, ConnectWhatsAppDto, TestEmailDto, TestWhatsAppDto, UpdateEmailSettingsDto,
} from './dto/channels.dto';

/**
 * Canales de aviso propios del espacio: la cuenta de Resend y la de WhatsApp
 * Business del cliente. Solo dueños y administradores del espacio.
 * Las operaciones que llaman a Resend o a Meta tienen un límite bajo.
 */
@UseGuards(AuthGuard('jwt'))
@Controller('workspaces/:workspaceId/channels')
export class ChannelsController {
  constructor(private readonly channels: ChannelsService) {}

  @Get()
  async overview(@Param('workspaceId') workspaceId: string, @Req() req: any) {
    return { data: await this.channels.overview(workspaceId, req.user.id) };
  }

  @Put('email')
  @Throttle(10, 60)
  async connectEmail(@Param('workspaceId') workspaceId: string, @Body() dto: ConnectEmailDto, @Req() req: any) {
    return { data: await this.channels.connectEmail(workspaceId, dto, req.user.id) };
  }

  @Patch('email')
  async updateEmail(@Param('workspaceId') workspaceId: string, @Body() dto: UpdateEmailSettingsDto, @Req() req: any) {
    return { data: await this.channels.updateEmailSettings(workspaceId, dto, req.user.id) };
  }

  @Post('email/verify')
  @Throttle(10, 60)
  async verifyEmail(@Param('workspaceId') workspaceId: string, @Req() req: any) {
    return { data: await this.channels.verifyEmail(workspaceId, req.user.id) };
  }

  @Post('email/test')
  @Throttle(5, 60)
  async testEmail(@Param('workspaceId') workspaceId: string, @Body() dto: TestEmailDto, @Req() req: any) {
    return { data: await this.channels.testEmail(workspaceId, dto.to, req.user.id) };
  }

  @Delete('email')
  async disconnectEmail(@Param('workspaceId') workspaceId: string, @Req() req: any) {
    return { data: await this.channels.disconnect(workspaceId, 'EMAIL', req.user.id) };
  }

  @Put('whatsapp')
  @Throttle(10, 60)
  async connectWhatsApp(@Param('workspaceId') workspaceId: string, @Body() dto: ConnectWhatsAppDto, @Req() req: any) {
    return { data: await this.channels.connectWhatsApp(workspaceId, dto, req.user.id) };
  }

  @Post('whatsapp/templates')
  @Throttle(5, 60)
  async submitTemplates(@Param('workspaceId') workspaceId: string, @Req() req: any) {
    return { data: await this.channels.submitTemplates(workspaceId, req.user.id) };
  }

  @Post('whatsapp/templates/refresh')
  @Throttle(10, 60)
  async refreshTemplates(@Param('workspaceId') workspaceId: string, @Req() req: any) {
    return { data: await this.channels.refreshTemplates(workspaceId, req.user.id) };
  }

  @Post('whatsapp/test')
  @Throttle(5, 60)
  async testWhatsApp(@Param('workspaceId') workspaceId: string, @Body() dto: TestWhatsAppDto, @Req() req: any) {
    return { data: await this.channels.testWhatsApp(workspaceId, dto, req.user.id) };
  }

  @Post('whatsapp/test/confirm')
  async confirmTest(@Param('workspaceId') workspaceId: string, @Body() dto: ConfirmTestDto, @Req() req: any) {
    return { data: await this.channels.confirmWhatsAppTest(workspaceId, dto.worked, req.user.id) };
  }

  @Delete('whatsapp')
  async disconnectWhatsApp(@Param('workspaceId') workspaceId: string, @Req() req: any) {
    return { data: await this.channels.disconnect(workspaceId, 'WHATSAPP', req.user.id) };
  }

  /** Reprograma los avisos que esperaban a que se arreglara un canal. */
  @Post('retry')
  @Throttle(5, 60)
  async retry(@Param('workspaceId') workspaceId: string, @Req() req: any) {
    return { data: await this.channels.retry(workspaceId, req.user.id) };
  }
}
