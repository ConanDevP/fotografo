import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Req, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AuthGuard } from '@nestjs/passport';
import { SkipThrottle } from '@nestjs/throttler';
import { ApiResponse } from '@shared/types';
import { WorkspacesService } from './workspaces.service';
import { CreateWorkspaceDto } from './dto/create-workspace.dto';
import { UpdateWorkspaceDto } from './dto/update-workspace.dto';
import { UpdateBrandThemeDto } from './dto/update-brand-theme.dto';
import { AddWorkspaceMemberDto } from './dto/add-workspace-member.dto';
import { UpdateWorkspaceMemberDto } from './dto/update-workspace-member.dto';

@Controller('workspaces')
export class WorkspacesController {
  constructor(private readonly workspaces: WorkspacesService) {}

  @Get('internal/tls/authorize')
  @SkipThrottle()
  async authorizeTlsDomain(@Query('domain') domain: string) {
    return this.workspaces.authorizeTlsDomain(domain || '');
  }

  @Get('public/domain/:domain')
  async publicStorefrontByDomain(@Param('domain') domain: string): Promise<ApiResponse> {
    return { data: await this.workspaces.findPublicByDomain(domain) };
  }

  @Get('public/:slug')
  async publicStorefront(@Param('slug') slug: string): Promise<ApiResponse> {
    return { data: await this.workspaces.findPublicBySlug(slug) };
  }

  @UseGuards(AuthGuard('jwt'))
  @Post()
  async create(@Body() dto: CreateWorkspaceDto, @Req() req: any): Promise<ApiResponse> {
    return { data: await this.workspaces.create(dto, req.user.id) };
  }

  @UseGuards(AuthGuard('jwt'))
  @Get('mine')
  async mine(@Req() req: any): Promise<ApiResponse> {
    return { data: await this.workspaces.findMine(req.user.id) };
  }

  @UseGuards(AuthGuard('jwt'))
  @Get(':workspaceId')
  async findOne(@Param('workspaceId') workspaceId: string, @Req() req: any): Promise<ApiResponse> {
    return { data: await this.workspaces.findOneForMember(workspaceId, req.user.id) };
  }

  @UseGuards(AuthGuard('jwt'))
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 5 * 1024 * 1024, files: 1 },
      fileFilter: (_req, file, callback) => {
        if (['image/jpeg', 'image/jpg', 'image/png'].includes(file.mimetype)) callback(null, true);
        else callback(new BadRequestException('Solo se permiten archivos JPG y PNG'), false);
      },
    }),
  )
  @Post(':workspaceId/brand-asset/:kind')
  async uploadBrandAsset(
    @Param('workspaceId') workspaceId: string,
    @Param('kind') kind: string,
    @UploadedFile() file: Express.Multer.File,
    @Req() req: any,
  ): Promise<ApiResponse> {
    if (kind !== 'logo' && kind !== 'cover') throw new BadRequestException('Recurso no válido');
    return { data: await this.workspaces.uploadBrandAsset(workspaceId, kind, file, req.user.id) };
  }

  @UseGuards(AuthGuard('jwt'))
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 5 * 1024 * 1024, files: 1 },
      fileFilter: (_req, file, callback) => {
        if (['image/jpeg', 'image/jpg', 'image/png'].includes(file.mimetype)) callback(null, true);
        else callback(new BadRequestException('Solo se permiten archivos JPG y PNG'), false);
      },
    }),
  )
  @Post(':workspaceId/assets')
  async uploadAsset(
    @Param('workspaceId') workspaceId: string,
    @UploadedFile() file: Express.Multer.File,
    @Req() req: any,
  ): Promise<ApiResponse> {
    return { data: await this.workspaces.uploadAsset(workspaceId, file, req.user.id) };
  }

  @UseGuards(AuthGuard('jwt'))
  @Delete(':workspaceId/brand-asset/:kind')
  async removeBrandAsset(
    @Param('workspaceId') workspaceId: string,
    @Param('kind') kind: string,
    @Req() req: any,
  ): Promise<ApiResponse> {
    if (kind !== 'logo' && kind !== 'cover') throw new BadRequestException('Recurso no válido');
    return { data: await this.workspaces.removeBrandAsset(workspaceId, kind, req.user.id) };
  }

  @UseGuards(AuthGuard('jwt'))
  @Patch(':workspaceId')
  async update(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: UpdateWorkspaceDto,
    @Req() req: any,
  ): Promise<ApiResponse> {
    return { data: await this.workspaces.update(workspaceId, dto, req.user.id) };
  }

  @UseGuards(AuthGuard('jwt'))
  @Put(':workspaceId/brand')
  async updateBrand(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: UpdateBrandThemeDto,
    @Req() req: any,
  ): Promise<ApiResponse> {
    return { data: await this.workspaces.updateBrand(workspaceId, dto, req.user.id) };
  }

  @UseGuards(AuthGuard('jwt'))
  @Post(':workspaceId/domain/verify')
  async verifyDomain(@Param('workspaceId') workspaceId: string, @Req() req: any): Promise<ApiResponse> {
    return { data: await this.workspaces.verifyCustomDomain(workspaceId, req.user.id) };
  }

  @UseGuards(AuthGuard('jwt'))
  @Post(':workspaceId/members')
  async addMember(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: AddWorkspaceMemberDto,
    @Req() req: any,
  ): Promise<ApiResponse> {
    return { data: await this.workspaces.addMember(workspaceId, dto, req.user.id) };
  }

  @UseGuards(AuthGuard('jwt'))
  @Patch(':workspaceId/members/:memberId')
  async updateMember(
    @Param('workspaceId') workspaceId: string,
    @Param('memberId') memberId: string,
    @Body() dto: UpdateWorkspaceMemberDto,
    @Req() req: any,
  ): Promise<ApiResponse> {
    return { data: await this.workspaces.updateMember(workspaceId, memberId, dto, req.user.id) };
  }
}
