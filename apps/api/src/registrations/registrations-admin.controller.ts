import { Body, Controller, Delete, Get, Param, Patch, Query, Req, Res, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Request, Response } from 'express';

import { RegistrationsService } from './registrations.service';
import { UpdateRegistrationConfigDto } from './dto/registration-admin.dto';
import { UserRole } from '@shared/types';

interface AuthenticatedRequest extends Request {
  user: { id: string; email: string; role: UserRole };
}

/** Panel del organizador o fotógrafo: activar el QR, ver y exportar los registros. */
@UseGuards(AuthGuard('jwt'))
@Controller('events/:eventId')
export class RegistrationsAdminController {
  constructor(private readonly registrations: RegistrationsService) {}

  @Get('registration')
  async config(@Param('eventId') eventId: string, @Req() req: AuthenticatedRequest) {
    return { data: await this.registrations.getConfig(eventId, req.user.id, req.user.role) };
  }

  @Patch('registration')
  async update(
    @Param('eventId') eventId: string,
    @Body() dto: UpdateRegistrationConfigDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return { data: await this.registrations.updateConfig(eventId, dto, req.user.id, req.user.role) };
  }

  @Get('registrations/export.csv')
  async exportCsv(@Param('eventId') eventId: string, @Req() req: AuthenticatedRequest, @Res() res: Response) {
    const csv = await this.registrations.exportCsv(eventId, req.user.id, req.user.role);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="registros-${eventId}.csv"`);
    res.send(csv);
  }

  @Get('registrations')
  async list(
    @Param('eventId') eventId: string,
    @Query('search') search: string | undefined,
    @Query('page') page: string | undefined,
    @Query('limit') limit: string | undefined,
    @Req() req: AuthenticatedRequest,
  ) {
    return {
      data: await this.registrations.list(
        eventId,
        { search, page: page ? parseInt(page, 10) : undefined, limit: limit ? parseInt(limit, 10) : undefined },
        req.user.id,
        req.user.role,
      ),
    };
  }

  @Delete('registrations/:registrationId')
  async remove(
    @Param('eventId') eventId: string,
    @Param('registrationId') registrationId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return { data: await this.registrations.remove(eventId, registrationId, req.user.id, req.user.role) };
  }
}
