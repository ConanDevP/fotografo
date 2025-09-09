// Endpoint temporal para debugging
// GET /public/photographers/debug

import { Controller, Get } from '@nestjs/common';
import { PrismaService } from '../common/services/prisma.service';
import { UserRole } from '@shared/types';

@Controller('public/photographers')
export class DebugController {
  constructor(private prisma: PrismaService) {}

  @Get('debug')
  async debug() {
    const allUsers = await this.prisma.user.findMany({
      where: { role: UserRole.PHOTOGRAPHER },
      select: {
        id: true,
        email: true,
        name: true,
        slug: true,
        role: true,
        createdAt: true
      }
    });

    const withSlug = await this.prisma.user.findMany({
      where: { 
        role: UserRole.PHOTOGRAPHER,
        slug: { not: null }
      },
      select: {
        id: true,
        email: true,
        name: true,
        slug: true
      }
    });

    return {
      totalPhotographers: allUsers.length,
      photographersWithSlugCount: withSlug.length,
      allPhotographers: allUsers,
      photographersWithSlug: withSlug
    };
  }
}