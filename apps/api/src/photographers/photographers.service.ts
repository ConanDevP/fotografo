import { Injectable, ConflictException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../common/services/prisma.service';
import { UpdatePhotographerProfileDto } from './dto/update-photographer-profile.dto';
import { PhotographerQueryDto } from './dto/photographer-query.dto';
import { 
  PhotographerProfileResponse, 
  PhotographerListResponse, 
  PhotographerStatsResponse 
} from './dto/photographer-response.dto';
import { UserRole, PhotoStatus, OrderStatus } from '@shared/types';

@Injectable()
export class PhotographersService {
  constructor(private prisma: PrismaService) {}

  async updatePhotographerProfile(
    userId: string, 
    data: UpdatePhotographerProfileDto
  ): Promise<PhotographerProfileResponse> {
    // Verificar que el usuario es fotógrafo
    const user = await this.prisma.user.findUnique({
      where: { id: userId }
    });

    if (!user) {
      throw new NotFoundException('Usuario no encontrado');
    }

    if (user.role !== UserRole.PHOTOGRAPHER) {
      throw new ForbiddenException('Solo fotógrafos pueden actualizar perfil de fotógrafo');
    }

    // Validar que el slug no esté tomado por otro usuario
    if (data.slug) {
      const existingUser = await this.prisma.user.findFirst({
        where: { 
          slug: data.slug,
          id: { not: userId }
        }
      });

      if (existingUser) {
        throw new ConflictException('Este slug ya está en uso');
      }
    }

    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: {
        ...data,
        updatedAt: new Date()
      },
      include: {
        _count: {
          select: {
            ownedEvents: true,
            photographedPhotos: {
              where: { status: PhotoStatus.PROCESSED }
            }
          }
        }
      }
    });

    return this.mapToPhotographerProfile(updatedUser);
  }

  async getPhotographerProfile(userId: string): Promise<PhotographerProfileResponse> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        _count: {
          select: {
            ownedEvents: true,
            photographedPhotos: {
              where: { status: PhotoStatus.PROCESSED }
            }
          }
        }
      }
    });

    if (!user) {
      throw new NotFoundException('Fotógrafo no encontrado');
    }

    if (user.role !== UserRole.PHOTOGRAPHER) {
      throw new ForbiddenException('El usuario no es fotógrafo');
    }

    return this.mapToPhotographerProfile(user);
  }

  async getPhotographerStats(userId: string): Promise<PhotographerStatsResponse> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId }
    });

    if (!user || user.role !== UserRole.PHOTOGRAPHER) {
      throw new NotFoundException('Fotógrafo no encontrado');
    }

    const [
      totalEvents,
      totalPhotos,
      totalProcessedPhotos,
      paidOrders,
      recentEvents
    ] = await Promise.all([
      this.prisma.event.count({
        where: { ownerId: userId }
      }),
      this.prisma.photo.count({
        where: { event: { ownerId: userId } }
      }),
      this.prisma.photo.count({
        where: { 
          event: { ownerId: userId },
          status: PhotoStatus.PROCESSED
        }
      }),
      this.prisma.order.findMany({
        where: { 
          event: { ownerId: userId },
          status: OrderStatus.PAID
        },
        include: {
          items: true
        }
      }),
      this.prisma.event.findMany({
        where: { ownerId: userId },
        orderBy: { date: 'desc' },
        take: 5,
        include: {
          _count: {
            select: {
              photos: {
                where: { status: PhotoStatus.PROCESSED }
              }
            }
          }
        }
      })
    ]);

    // Calcular ingresos totales
    const totalRevenue = paidOrders.reduce((total, order) => {
      return total + order.amountCents;
    }, 0);

    const averagePhotosPerEvent = totalEvents > 0 ? totalPhotos / totalEvents : 0;

    return {
      totalEvents,
      totalPhotos,
      totalProcessedPhotos,
      totalRevenue,
      averagePhotosPerEvent: Math.round(averagePhotosPerEvent * 100) / 100,
      recentEvents: recentEvents.map(event => ({
        id: event.id,
        name: event.name,
        date: event.date.toISOString(),
        photoCount: event._count.photos
      }))
    };
  }

  async validateSlug(slug: string, excludeUserId?: string): Promise<boolean> {
    const where: any = { slug };
    
    if (excludeUserId) {
      where.id = { not: excludeUserId };
    }

    const existingUser = await this.prisma.user.findFirst({ where });
    return !existingUser;
  }

  private mapToPhotographerProfile(user: any): PhotographerProfileResponse {
    return {
      id: user.id,
      slug: user.slug,
      name: user.name,
      email: user.email,
      profileImageUrl: user.profileImageUrl,
      bio: user.bio,
      website: user.website,
      instagram: user.instagram,
      facebook: user.facebook,
      specialties: user.specialties || [],
      experienceYears: user.experienceYears,
      location: user.location,
      portfolioUrl: user.portfolioUrl,
      isVerified: user.isVerified,
      createdAt: user.createdAt.toISOString(),
      stats: {
        totalEvents: user._count?.ownedEvents || 0,
        totalPhotos: user._count?.photographedPhotos || 0
      }
    };
  }
}