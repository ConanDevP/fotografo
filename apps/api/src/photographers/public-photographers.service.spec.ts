import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { PublicPhotographersService } from './public-photographers.service';
import { PrismaService } from '../common/services/prisma.service';
import { UserRole } from '@shared/types';

describe('PublicPhotographersService', () => {
  let service: PublicPhotographersService;
  let prismaService: jest.Mocked<PrismaService>;

  const mockPhotographer = {
    id: '123',
    slug: 'test-photographer',
    name: 'Test Photographer',
    email: 'test@example.com',
    role: UserRole.PHOTOGRAPHER,
    profileImageUrl: 'https://example.com/avatar.jpg',
    bio: 'Test bio',
    location: 'Test City',
    specialties: ['running', 'cycling'],
    experienceYears: 5,
    isVerified: true,
    createdAt: new Date(),
    _count: {
      ownedEvents: 10,
      photographedPhotos: 500
    }
  };

  beforeEach(async () => {
    const mockPrisma = {
      user: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        count: jest.fn()
      },
      event: {
        findMany: jest.fn(),
        count: jest.fn()
      }
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PublicPhotographersService,
        {
          provide: PrismaService,
          useValue: mockPrisma
        }
      ]
    }).compile();

    service = module.get<PublicPhotographersService>(PublicPhotographersService);
    prismaService = module.get(PrismaService);
  });

  describe('findPhotographers', () => {
    it('should return paginated photographers list', async () => {
      prismaService.user.findMany.mockResolvedValue([mockPhotographer]);
      prismaService.user.count.mockResolvedValue(1);

      const result = await service.findPhotographers({}, 1, 20);

      expect(result.items).toHaveLength(1);
      expect(result.items[0].slug).toBe('test-photographer');
      expect(result.pagination.total).toBe(1);
      expect(result.pagination.pages).toBe(1);
    });

    it('should filter by location', async () => {
      const query = { location: 'test city' };
      prismaService.user.findMany.mockResolvedValue([]);
      prismaService.user.count.mockResolvedValue(0);

      await service.findPhotographers(query);

      expect(prismaService.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            location: {
              contains: 'test city',
              mode: 'insensitive'
            }
          })
        })
      );
    });

    it('should filter by specialties', async () => {
      const query = { specialties: ['running', 'cycling'] };
      prismaService.user.findMany.mockResolvedValue([]);
      prismaService.user.count.mockResolvedValue(0);

      await service.findPhotographers(query);

      expect(prismaService.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            specialties: {
              hasSome: ['running', 'cycling']
            }
          })
        })
      );
    });

    it('should search by name and bio', async () => {
      const query = { search: 'test photographer' };
      prismaService.user.findMany.mockResolvedValue([]);
      prismaService.user.count.mockResolvedValue(0);

      await service.findPhotographers(query);

      expect(prismaService.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: expect.arrayContaining([
              {
                name: {
                  contains: 'test photographer',
                  mode: 'insensitive'
                }
              },
              {
                bio: {
                  contains: 'test photographer',
                  mode: 'insensitive'
                }
              }
            ])
          })
        })
      );
    });
  });

  describe('getPhotographerBySlug', () => {
    it('should return photographer profile by slug', async () => {
      prismaService.user.findUnique.mockResolvedValue(mockPhotographer);

      const result = await service.getPhotographerBySlug('test-photographer');

      expect(result.slug).toBe('test-photographer');
      expect(result.stats.totalEvents).toBe(10);
      expect(result.stats.totalPhotos).toBe(500);
    });

    it('should throw NotFoundException if photographer not found', async () => {
      prismaService.user.findUnique.mockResolvedValue(null);

      await expect(service.getPhotographerBySlug('nonexistent'))
        .rejects.toThrow(NotFoundException);
    });
  });

  describe('getPhotographerEvents', () => {
    it('should return photographer events', async () => {
      prismaService.user.findUnique.mockResolvedValue({
        id: '123',
        name: 'Test Photographer'
      });
      
      const mockEvents = [
        {
          id: '1',
          name: 'Event 1',
          slug: 'event-1',
          date: new Date(),
          location: 'City 1',
          imageUrl: 'image1.jpg',
          createdAt: new Date(),
          _count: { photos: 50 }
        }
      ];
      
      prismaService.event.findMany.mockResolvedValue(mockEvents as any);
      prismaService.event.count.mockResolvedValue(1);

      const result = await service.getPhotographerEvents('test-photographer');

      expect(result.items).toHaveLength(1);
      expect(result.items[0].name).toBe('Event 1');
      expect(result.photographer.name).toBe('Test Photographer');
    });

    it('should throw NotFoundException if photographer not found', async () => {
      prismaService.user.findUnique.mockResolvedValue(null);

      await expect(service.getPhotographerEvents('nonexistent'))
        .rejects.toThrow(NotFoundException);
    });
  });
});