import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/services/prisma.service';
import { PhotographerQueryDto } from './dto/photographer-query.dto';
import { PhotographerListResponse, PhotographerProfileResponse } from './dto/photographer-response.dto';
import { UserRole, PhotoStatus } from '@shared/types';

@Injectable()
export class PublicPhotographersService {
  constructor(private prisma: PrismaService) {}

  async findPhotographers(
    query: PhotographerQueryDto,
    page: number = 1,
    limit: number = 20
  ): Promise<{ 
    items: PhotographerListResponse[]; 
    pagination: { page: number; limit: number; total: number; pages: number };
  }> {
    const skip = (page - 1) * limit;
    
    // Construir filtros
    const where: any = {
      role: UserRole.PHOTOGRAPHER,
      slug: { not: null }, // Solo fotógrafos con perfil público configurado
    };

    if (query.location) {
      where.location = {
        contains: query.location.trim(),
        mode: 'insensitive'
      };
    }

    if (query.specialties) {
      const specialtiesArray = typeof query.specialties === 'string' 
        ? query.specialties.split(',').map(s => s.trim().toLowerCase())
        : query.specialties.map(s => s.trim().toLowerCase());
      
      if (specialtiesArray.length > 0) {
        where.specialties = {
          hasSome: specialtiesArray
        };
      }
    }

    if (query.featured !== undefined) {
      const featured = typeof query.featured === 'string' 
        ? query.featured.toLowerCase() === 'true'
        : Boolean(query.featured);
      where.isFeatured = featured;
    }

    if (query.verified !== undefined) {
      const verified = typeof query.verified === 'string'
        ? query.verified.toLowerCase() === 'true' 
        : Boolean(query.verified);
      where.isVerified = verified;
    }

    if (query.search) {
      where.OR = [
        {
          name: {
            contains: query.search,
            mode: 'insensitive'
          }
        },
        {
          bio: {
            contains: query.search,
            mode: 'insensitive'
          }
        },
        {
          location: {
            contains: query.search,
            mode: 'insensitive'
          }
        }
      ];
    }

    // Construir ordenamiento
    const orderBy = this.buildOrderBy(query.orderBy, query.orderDirection);

    const [photographers, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        select: {
          slug: true,
          name: true,
          profileImageUrl: true,
          bio: true,
          location: true,
          specialties: true,
          experienceYears: true,
          isVerified: true,
          _count: {
            select: {
              ownedEvents: true
            }
          }
        },
        orderBy,
        skip,
        take: limit
      }),
      this.prisma.user.count({ where })
    ]);

    const items: PhotographerListResponse[] = photographers.map(photographer => ({
      slug: photographer.slug!,
      name: photographer.name || 'Sin nombre',
      profileImageUrl: photographer.profileImageUrl,
      bio: photographer.bio,
      location: photographer.location,
      specialties: photographer.specialties || [],
      experienceYears: photographer.experienceYears,
      isVerified: photographer.isVerified,
      eventCount: photographer._count.ownedEvents
    }));

    const pages = Math.ceil(total / limit);

    return {
      items,
      pagination: { page, limit, total, pages }
    };
  }

  async getPhotographerBySlug(slug: string): Promise<PhotographerProfileResponse> {
    const photographer = await this.prisma.user.findUnique({
      where: { 
        slug,
        role: UserRole.PHOTOGRAPHER
      },
      select: {
        id: true,
        slug: true,
        name: true,
        email: true,
        profileImageUrl: true,
        bio: true,
        website: true,
        instagram: true,
        facebook: true,
        specialties: true,
        experienceYears: true,
        location: true,
        portfolioUrl: true,
        isVerified: true,
        createdAt: true,
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

    if (!photographer) {
      throw new NotFoundException('Fotógrafo no encontrado');
    }

    return {
      id: photographer.id,
      slug: photographer.slug!,
      name: photographer.name || 'Sin nombre',
      email: photographer.email,
      profileImageUrl: photographer.profileImageUrl,
      bio: photographer.bio,
      website: photographer.website,
      instagram: photographer.instagram,
      facebook: photographer.facebook,
      specialties: photographer.specialties || [],
      experienceYears: photographer.experienceYears,
      location: photographer.location,
      portfolioUrl: photographer.portfolioUrl,
      isVerified: photographer.isVerified,
      createdAt: photographer.createdAt.toISOString(),
      stats: {
        totalEvents: photographer._count.ownedEvents,
        totalPhotos: photographer._count.photographedPhotos
      }
    };
  }

  async getPhotographerEvents(
    slug: string,
    page: number = 1,
    limit: number = 20
  ) {
    const photographer = await this.prisma.user.findUnique({
      where: { 
        slug,
        role: UserRole.PHOTOGRAPHER
      },
      select: { id: true, name: true }
    });

    if (!photographer) {
      throw new NotFoundException('Fotógrafo no encontrado');
    }

    const skip = (page - 1) * limit;

    const [events, total] = await Promise.all([
      this.prisma.event.findMany({
        where: { 
          ownerId: photographer.id,
          deletedAt: null
        },
        include: {
          _count: {
            select: {
              photos: {
                where: { status: PhotoStatus.PROCESSED }
              }
            }
          }
        },
        orderBy: { date: 'desc' },
        skip,
        take: limit
      }),
      this.prisma.event.count({
        where: { 
          ownerId: photographer.id,
          deletedAt: null
        }
      })
    ]);

    const items = events.map(event => ({
      id: event.id,
      name: event.name,
      slug: event.slug,
      date: event.date.toISOString(),
      location: event.location,
      imageUrl: event.imageUrl,
      photoCount: event._count.photos,
      createdAt: event.createdAt.toISOString()
    }));

    const pages = Math.ceil(total / limit);

    return {
      photographer: {
        name: photographer.name,
        slug
      },
      items,
      pagination: { page, limit, total, pages }
    };
  }

  private buildOrderBy(orderBy?: string, direction: string = 'desc'): any[] {
    const orderDirection = direction?.toLowerCase() === 'asc' ? 'asc' : 'desc';
    const baseOrder = [];

    switch (orderBy?.toLowerCase()) {
      case 'featured':
        baseOrder.push({ isFeatured: orderDirection });
        break;
      case 'verified':
        baseOrder.push({ isVerified: orderDirection });
        break;
      case 'experience':
        baseOrder.push({ experienceYears: orderDirection });
        break;
      case 'events':
        // Esto requeriría un subquery más complejo, por ahora usamos el orden por defecto
        break;
      case 'recent':
        baseOrder.push({ createdAt: orderDirection });
        break;
      default:
        // Orden por defecto: destacados primero, verificados segundo, más recientes tercero
        baseOrder.push({ isFeatured: 'desc' });
        baseOrder.push({ isVerified: 'desc' });
        baseOrder.push({ createdAt: 'desc' });
    }

    return baseOrder;
  }
}