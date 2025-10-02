import {
  Controller,
  Get,
  Patch,
  Delete,
  Post,
  Param,
  Query,
  Body,
  UseGuards,
  Req,
  ParseIntPipe,
  DefaultValuePipe,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Request } from 'express';

import { AdminUsersService } from './admin-users.service';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { UpdateUserDto } from './dto/update-user.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { UserRole, ApiResponse } from '@shared/types';

interface AuthenticatedRequest extends Request {
  user: {
    id: string;
    email: string;
    role: UserRole;
  };
}

@Controller('admin/users')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(UserRole.ADMIN)
export class AdminUsersController {
  constructor(private readonly adminUsersService: AdminUsersService) {}

  @Get()
  async getAllUsers(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('role') role?: UserRole,
    @Query('isVerified') isVerified?: string,
    @Query('isFeatured') isFeatured?: string,
    @Query('search') search?: string,
    @Req() req?: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    const filters: any = {};

    if (role) filters.role = role;
    if (isVerified !== undefined) filters.isVerified = isVerified === 'true';
    if (isFeatured !== undefined) filters.isFeatured = isFeatured === 'true';
    if (search) filters.search = search;

    const result = await this.adminUsersService.getAllUsers(
      req.user.role,
      page,
      limit,
      filters,
    );

    return {
      data: result.items,
      meta: { pagination: result.pagination },
    };
  }

  @Get('stats')
  async getUserStats(@Req() req: AuthenticatedRequest): Promise<ApiResponse> {
    const stats = await this.adminUsersService.getUserStats(req.user.role);
    return { data: stats };
  }

  @Get(':id')
  async getUserById(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    const user = await this.adminUsersService.getUserById(id, req.user.role);
    return { data: user };
  }

  @Patch(':id')
  async updateUser(
    @Param('id') id: string,
    @Body() updateDto: UpdateUserDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    const user = await this.adminUsersService.updateUser(id, updateDto, req.user.role);
    return { data: user };
  }

  @Delete(':id')
  async deleteUser(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    const result = await this.adminUsersService.deleteUser(id, req.user.role);
    return { data: result };
  }

  @Patch(':id/verify')
  async toggleVerified(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    const user = await this.adminUsersService.toggleVerified(id, req.user.role);
    return { data: user };
  }

  @Patch(':id/feature')
  async toggleFeatured(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    const user = await this.adminUsersService.toggleFeatured(id, req.user.role);
    return { data: user };
  }

  @Post(':id/reset-password')
  async resetPassword(
    @Param('id') id: string,
    @Body() resetDto: ResetPasswordDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<ApiResponse> {
    const result = await this.adminUsersService.resetUserPassword(
      id,
      resetDto.newPassword,
      req.user.role,
    );
    return { data: result };
  }
}
