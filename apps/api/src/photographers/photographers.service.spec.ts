import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PhotographersService } from './photographers.service';
import { PrismaService } from '../common/services/prisma.service';
import { UserRole, PhotoStatus } from '@shared/types';

describe('PhotographersService', () => {
  let service: PhotographersService;
  let prismaService: jest.Mocked<PrismaService>;

  const mockUser = {
    id: '123',
    email: 'photographer@test.com',
    role: UserRole.PHOTOGRAPHER,
    slug: 'test-photographer',
    name: 'Test Photographer',
    createdAt: new Date(),
    _count: {
      ownedEvents: 5,
      photographedPhotos: 100
    }
  };

  beforeEach(async () => {
    const mockPrisma = {
      user: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        update: jest.fn(),
        count: jest.fn()
      },
      event: {
        count: jest.fn(),
        findMany: jest.fn()
      },
      photo: {
        count: jest.fn()
      },
      order: {
        findMany: jest.fn()
      }
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PhotographersService,
        {
          provide: PrismaService,
          useValue: mockPrisma
        }
      ]
    }).compile();

    service = module.get<PhotographersService>(PhotographersService);
    prismaService = module.get(PrismaService);
  });

  describe('updatePhotographerProfile', () => {
    it('should update photographer profile successfully', async () => {
      prismaService.user.findUnique.mockResolvedValue(mockUser);
      prismaService.user.findFirst.mockResolvedValue(null); // Slug available
      prismaService.user.update.mockResolvedValue(mockUser);

      const updateData = {
        slug: 'new-slug',
        bio: 'New bio'
      };

      const result = await service.updatePhotographerProfile('123', updateData);

      expect(result.id).toBe('123');
      expect(prismaService.user.findFirst).toHaveBeenCalledWith({
        where: { 
          slug: 'new-slug',
          id: { not: '123' }
        }
      });
      expect(prismaService.user.update).toHaveBeenCalled();
    });

    it('should throw ConflictException if slug is already taken', async () => {
      prismaService.user.findUnique.mockResolvedValue(mockUser);
      prismaService.user.findFirst.mockResolvedValue({ id: '456' } as any); // Slug taken

      const updateData = { slug: 'taken-slug' };

      await expect(service.updatePhotographerProfile('123', updateData))
        .rejects.toThrow(ConflictException);
    });

    it('should throw NotFoundException if user not found', async () => {
      prismaService.user.findUnique.mockResolvedValue(null);

      const updateData = { bio: 'New bio' };

      await expect(service.updatePhotographerProfile('123', updateData))
        .rejects.toThrow(NotFoundException);
    });

    it('should throw ForbiddenException if user is not photographer', async () => {
      const nonPhotographer = { ...mockUser, role: UserRole.ATHLETE };
      prismaService.user.findUnique.mockResolvedValue(nonPhotographer as any);

      const updateData = { bio: 'New bio' };

      await expect(service.updatePhotographerProfile('123', updateData))
        .rejects.toThrow(ForbiddenException);
    });
  });

  describe('validateSlug', () => {
    it('should return true if slug is available', async () => {
      prismaService.user.findFirst.mockResolvedValue(null);

      const result = await service.validateSlug('available-slug');

      expect(result).toBe(true);
      expect(prismaService.user.findFirst).toHaveBeenCalledWith({
        where: { slug: 'available-slug' }
      });
    });

    it('should return false if slug is taken', async () => {
      prismaService.user.findFirst.mockResolvedValue({ id: '456' } as any);

      const result = await service.validateSlug('taken-slug');

      expect(result).toBe(false);
    });

    it('should exclude current user when validating slug', async () => {
      prismaService.user.findFirst.mockResolvedValue(null);

      await service.validateSlug('test-slug', '123');

      expect(prismaService.user.findFirst).toHaveBeenCalledWith({
        where: { 
          slug: 'test-slug',
          id: { not: '123' }
        }
      });
    });
  });

  describe('getPhotographerStats', () => {
    it('should return photographer stats', async () => {
      prismaService.user.findUnique.mockResolvedValue(mockUser);
      prismaService.event.count.mockResolvedValue(5);
      prismaService.photo.count
        .mockResolvedValueOnce(100) // total photos
        .mockResolvedValueOnce(95); // processed photos
      prismaService.order.findMany.mockResolvedValue([
        { amountCents: 1000, items: [] },
        { amountCents: 1500, items: [] }
      ] as any);
      prismaService.event.findMany.mockResolvedValue([
        {
          id: '1',
          name: 'Event 1',
          date: new Date(),
          _count: { photos: 20 }
        }
      ] as any);

      const result = await service.getPhotographerStats('123');

      expect(result.totalEvents).toBe(5);
      expect(result.totalPhotos).toBe(100);
      expect(result.totalProcessedPhotos).toBe(95);
      expect(result.totalRevenue).toBe(2500);
      expect(result.averagePhotosPerEvent).toBe(20);
      expect(result.recentEvents).toHaveLength(1);
    });
  });
});