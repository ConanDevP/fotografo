import { Injectable, ForbiddenException, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../common/services/prisma.service';
import { UserRole } from '@shared/types';
import { ERROR_CODES } from '@shared/constants';
import { UpdateUserDto } from './dto/update-user.dto';
import * as bcrypt from 'bcrypt';

@Injectable()
export class AdminUsersService {
  constructor(private prisma: PrismaService) {}

  async getAllUsers(
    userRole: UserRole,
    page = 1,
    limit = 20,
    filters?: {
      role?: UserRole;
      isVerified?: boolean;
      isFeatured?: boolean;
      search?: string;
    }
  ) {
    if (userRole !== UserRole.ADMIN) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'Solo administradores pueden listar usuarios',
      });
    }

    const skip = (page - 1) * limit;
    const where: any = {};

    if (filters?.role) {
      where.role = filters.role;
    }

    if (filters?.isVerified !== undefined) {
      where.isVerified = filters.isVerified;
    }

    if (filters?.isFeatured !== undefined) {
      where.isFeatured = filters.isFeatured;
    }

    if (filters?.search) {
      where.OR = [
        { email: { contains: filters.search, mode: 'insensitive' } },
        { name: { contains: filters.search, mode: 'insensitive' } },
        { slug: { contains: filters.search, mode: 'insensitive' } },
      ];
    }

    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          email: true,
          name: true,
          phone: true,
          role: true,
          slug: true,
          isVerified: true,
          isFeatured: true,
          location: true,
          createdAt: true,
          _count: {
            select: {
              ownedEvents: true,
              photographedPhotos: true,
              orders: true,
            },
          },
        },
      }),
      this.prisma.user.count({ where }),
    ]);

    return {
      items: users,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  async getUserById(userId: string, userRole: UserRole) {
    if (userRole !== UserRole.ADMIN) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'Solo administradores pueden ver detalles de usuarios',
      });
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        phone: true,
        profileImageUrl: true,
        address: true,
        role: true,
        slug: true,
        bio: true,
        website: true,
        instagram: true,
        facebook: true,
        specialties: true,
        experienceYears: true,
        location: true,
        portfolioUrl: true,
        isFeatured: true,
        isVerified: true,
        createdAt: true,
        updatedAt: true,
        _count: {
          select: {
            ownedEvents: true,
            photographedPhotos: true,
            orders: true,
          },
        },
      },
    });

    if (!user) {
      throw new NotFoundException({
        code: ERROR_CODES.USER_NOT_FOUND,
        message: 'Usuario no encontrado',
      });
    }

    return user;
  }

  async updateUser(userId: string, updateDto: UpdateUserDto, userRole: UserRole) {
    if (userRole !== UserRole.ADMIN) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'Solo administradores pueden actualizar usuarios',
      });
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException({
        code: ERROR_CODES.USER_NOT_FOUND,
        message: 'Usuario no encontrado',
      });
    }

    // Check if email is being changed and already exists
    if (updateDto.email && updateDto.email !== user.email) {
      const existingUser = await this.prisma.user.findUnique({
        where: { email: updateDto.email },
      });

      if (existingUser) {
        throw new BadRequestException({
          code: ERROR_CODES.USER_ALREADY_EXISTS,
          message: 'El email ya está en uso',
        });
      }
    }

    // Check if slug is being changed and already exists
    if (updateDto.slug && updateDto.slug !== user.slug) {
      const existingSlug = await this.prisma.user.findUnique({
        where: { slug: updateDto.slug },
      });

      if (existingSlug) {
        throw new BadRequestException({
          code: ERROR_CODES.SLUG_ALREADY_EXISTS,
          message: 'El slug ya está en uso',
        });
      }
    }

    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: updateDto,
      select: {
        id: true,
        email: true,
        name: true,
        phone: true,
        role: true,
        slug: true,
        isVerified: true,
        isFeatured: true,
        bio: true,
        website: true,
        instagram: true,
        facebook: true,
        location: true,
        updatedAt: true,
      },
    });

    return updatedUser;
  }

  async deleteUser(userId: string, userRole: UserRole) {
    if (userRole !== UserRole.ADMIN) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'Solo administradores pueden eliminar usuarios',
      });
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        _count: {
          select: {
            ownedEvents: true,
            photographedPhotos: true,
            orders: true,
          },
        },
      },
    });

    if (!user) {
      throw new NotFoundException({
        code: ERROR_CODES.USER_NOT_FOUND,
        message: 'Usuario no encontrado',
      });
    }

    // Check if user has dependencies
    if (user._count.ownedEvents > 0 || user._count.photographedPhotos > 0) {
      throw new BadRequestException({
        code: ERROR_CODES.USER_HAS_DEPENDENCIES,
        message: 'No se puede eliminar un usuario con eventos o fotos asociadas',
      });
    }

    await this.prisma.user.delete({
      where: { id: userId },
    });

    return { message: 'Usuario eliminado correctamente' };
  }

  async toggleVerified(userId: string, userRole: UserRole) {
    if (userRole !== UserRole.ADMIN) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'Solo administradores pueden verificar usuarios',
      });
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, isVerified: true },
    });

    if (!user) {
      throw new NotFoundException({
        code: ERROR_CODES.USER_NOT_FOUND,
        message: 'Usuario no encontrado',
      });
    }

    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: { isVerified: !user.isVerified },
      select: {
        id: true,
        email: true,
        name: true,
        isVerified: true,
      },
    });

    return updatedUser;
  }

  async toggleFeatured(userId: string, userRole: UserRole) {
    if (userRole !== UserRole.ADMIN) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'Solo administradores pueden destacar usuarios',
      });
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, isFeatured: true },
    });

    if (!user) {
      throw new NotFoundException({
        code: ERROR_CODES.USER_NOT_FOUND,
        message: 'Usuario no encontrado',
      });
    }

    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: { isFeatured: !user.isFeatured },
      select: {
        id: true,
        email: true,
        name: true,
        isFeatured: true,
      },
    });

    return updatedUser;
  }

  async resetUserPassword(userId: string, newPassword: string, userRole: UserRole) {
    if (userRole !== UserRole.ADMIN) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'Solo administradores pueden resetear contraseñas',
      });
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException({
        code: ERROR_CODES.USER_NOT_FOUND,
        message: 'Usuario no encontrado',
      });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: hashedPassword },
    });

    return { message: 'Contraseña reseteada correctamente' };
  }

  async getUserStats(userRole: UserRole) {
    if (userRole !== UserRole.ADMIN) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'Solo administradores pueden ver estadísticas de usuarios',
      });
    }

    const [totalUsers, usersByRole, verifiedCount, featuredCount, recentUsers] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.user.groupBy({
        by: ['role'],
        _count: { role: true },
      }),
      this.prisma.user.count({ where: { isVerified: true } }),
      this.prisma.user.count({ where: { isFeatured: true } }),
      this.prisma.user.count({
        where: {
          createdAt: {
            gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // Last 30 days
          },
        },
      }),
    ]);

    const roleStats = usersByRole.reduce((acc, stat) => {
      acc[stat.role] = stat._count.role;
      return acc;
    }, {} as Record<string, number>);

    return {
      total: totalUsers,
      byRole: roleStats,
      verified: verifiedCount,
      featured: featuredCount,
      recentSignups: recentUsers,
    };
  }
}
