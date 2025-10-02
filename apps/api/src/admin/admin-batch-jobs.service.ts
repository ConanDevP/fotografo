import { Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/services/prisma.service';
import { UserRole } from '@shared/types';
import { ERROR_CODES } from '@shared/constants';

@Injectable()
export class AdminBatchJobsService {
  constructor(private prisma: PrismaService) {}

  async getAllBatchJobs(
    userRole: UserRole,
    page = 1,
    limit = 20,
    filters?: {
      status?: string;
      ownerId?: string;
      eventId?: string;
      dateFrom?: string;
      dateTo?: string;
    }
  ) {
    if (userRole !== UserRole.ADMIN) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'Solo administradores pueden listar trabajos de carga',
      });
    }

    const skip = (page - 1) * limit;
    const where: any = {};

    if (filters?.status) {
      where.status = filters.status;
    }

    if (filters?.ownerId) {
      where.ownerId = filters.ownerId;
    }

    if (filters?.eventId) {
      where.eventId = filters.eventId;
    }

    if (filters?.dateFrom || filters?.dateTo) {
      where.createdAt = {};
      if (filters?.dateFrom) {
        where.createdAt.gte = new Date(filters.dateFrom);
      }
      if (filters?.dateTo) {
        where.createdAt.lte = new Date(filters.dateTo);
      }
    }

    const [jobs, total] = await Promise.all([
      this.prisma.batchUploadJob.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          owner: {
            select: {
              id: true,
              email: true,
              name: true,
            },
          },
          event: {
            select: {
              id: true,
              name: true,
              slug: true,
            },
          },
          _count: {
            select: {
              photos: true,
            },
          },
        },
      }),
      this.prisma.batchUploadJob.count({ where }),
    ]);

    return {
      items: jobs,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  async getBatchJobById(jobId: string, userRole: UserRole) {
    if (userRole !== UserRole.ADMIN) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'Solo administradores pueden ver detalles de trabajos',
      });
    }

    const job = await this.prisma.batchUploadJob.findUnique({
      where: { id: jobId },
      include: {
        owner: {
          select: {
            id: true,
            email: true,
            name: true,
            phone: true,
          },
        },
        event: {
          select: {
            id: true,
            name: true,
            slug: true,
            date: true,
          },
        },
        photos: {
          take: 10,
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            status: true,
            thumbUrl: true,
            createdAt: true,
          },
        },
        _count: {
          select: {
            photos: true,
          },
        },
      },
    });

    if (!job) {
      throw new NotFoundException({
        code: ERROR_CODES.BATCH_JOB_NOT_FOUND,
        message: 'Trabajo no encontrado',
      });
    }

    return job;
  }

  async getBatchJobsStats(userRole: UserRole) {
    if (userRole !== UserRole.ADMIN) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'Solo administradores pueden ver estadísticas de trabajos',
      });
    }

    const [totalJobs, jobsByStatus, recentJobs, totalFilesProcessed] = await Promise.all([
      this.prisma.batchUploadJob.count(),
      this.prisma.batchUploadJob.groupBy({
        by: ['status'],
        _count: { status: true },
        _sum: {
          totalFiles: true,
          uploadedFiles: true,
          processedFiles: true,
        },
      }),
      this.prisma.batchUploadJob.count({
        where: {
          createdAt: {
            gte: new Date(Date.now() - 24 * 60 * 60 * 1000), // Last 24 hours
          },
        },
      }),
      this.prisma.batchUploadJob.aggregate({
        _sum: {
          processedFiles: true,
          uploadedFiles: true,
        },
      }),
    ]);

    const statusStats = jobsByStatus.reduce((acc, stat) => {
      acc[stat.status] = {
        count: stat._count.status,
        totalFiles: stat._sum.totalFiles || 0,
        uploadedFiles: stat._sum.uploadedFiles || 0,
        processedFiles: stat._sum.processedFiles || 0,
      };
      return acc;
    }, {} as Record<string, any>);

    return {
      total: totalJobs,
      byStatus: statusStats,
      recentJobs,
      totalFilesProcessed: totalFilesProcessed._sum.processedFiles || 0,
      totalFilesUploaded: totalFilesProcessed._sum.uploadedFiles || 0,
    };
  }

  async retryBatchJob(jobId: string, userRole: UserRole) {
    if (userRole !== UserRole.ADMIN) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'Solo administradores pueden reintentar trabajos',
      });
    }

    const job = await this.prisma.batchUploadJob.findUnique({
      where: { id: jobId },
    });

    if (!job) {
      throw new NotFoundException({
        code: ERROR_CODES.BATCH_JOB_NOT_FOUND,
        message: 'Trabajo no encontrado',
      });
    }

    // Reset job to PENDING status
    const updatedJob = await this.prisma.batchUploadJob.update({
      where: { id: jobId },
      data: {
        status: 'PENDING',
        uploadedFiles: 0,
        processedFiles: 0,
        watermarkFiles: 0,
        geminiFiles: 0,
        faceFiles: 0,
        failedWatermarks: 0,
        failedGemini: 0,
        failedFaces: 0,
      },
    });

    // Log the action
    await this.prisma.auditLog.create({
      data: {
        action: 'BATCH_JOB_RETRIED',
        data: {
          jobId,
          previousStatus: job.status,
        },
      },
    });

    return updatedJob;
  }

  async cancelBatchJob(jobId: string, userRole: UserRole) {
    if (userRole !== UserRole.ADMIN) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'Solo administradores pueden cancelar trabajos',
      });
    }

    const job = await this.prisma.batchUploadJob.findUnique({
      where: { id: jobId },
    });

    if (!job) {
      throw new NotFoundException({
        code: ERROR_CODES.BATCH_JOB_NOT_FOUND,
        message: 'Trabajo no encontrado',
      });
    }

    const updatedJob = await this.prisma.batchUploadJob.update({
      where: { id: jobId },
      data: {
        status: 'FAILED',
      },
    });

    return updatedJob;
  }

  async deleteBatchJob(jobId: string, userRole: UserRole) {
    if (userRole !== UserRole.ADMIN) {
      throw new ForbiddenException({
        code: ERROR_CODES.FORBIDDEN,
        message: 'Solo administradores pueden eliminar trabajos',
      });
    }

    const job = await this.prisma.batchUploadJob.findUnique({
      where: { id: jobId },
      include: {
        _count: {
          select: {
            photos: true,
          },
        },
      },
    });

    if (!job) {
      throw new NotFoundException({
        code: ERROR_CODES.BATCH_JOB_NOT_FOUND,
        message: 'Trabajo no encontrado',
      });
    }

    await this.prisma.batchUploadJob.delete({
      where: { id: jobId },
    });

    return {
      message: 'Trabajo eliminado correctamente',
      photosCount: job._count.photos,
    };
  }
}
