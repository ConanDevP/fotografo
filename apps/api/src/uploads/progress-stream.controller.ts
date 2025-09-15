import {
  Controller,
  Get,
  Param,
  Req,
  Res,
  UseGuards,
  Logger,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Request, Response } from 'express';
import { UploadsService } from './uploads.service';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '@shared/types';

interface AuthenticatedRequest extends Request {
  user: {
    id: string;
    email: string;
    role: UserRole;
  };
}

@Controller('uploads')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles(UserRole.PHOTOGRAPHER, UserRole.ADMIN)
export class ProgressStreamController {
  private readonly logger = new Logger(ProgressStreamController.name);

  constructor(private readonly uploadsService: UploadsService) {}

  @Get('batch/:jobId/progress-stream')
  async getProgressStream(
    @Param('jobId') jobId: string,
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
  ) {
    this.logger.log(`Starting progress stream for batch ${jobId}`);

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Cache-Control');

    // Send initial connection event
    res.write(`data: ${JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() })}\n\n`);

    let intervalId: NodeJS.Timeout;
    let isClientConnected = true;

    // Function to send progress updates
    const sendProgressUpdate = async () => {
      if (!isClientConnected) return;

      try {
        // Check if user has permission to view this batch
        const basicStatus = await this.uploadsService.getBatchUploadStatus(jobId, req.user.id);
        
        if (!basicStatus) {
          res.write(`data: ${JSON.stringify({ 
            type: 'error', 
            message: 'Batch not found or no permission',
            timestamp: new Date().toISOString()
          })}\n\n`);
          return;
        }

        // Get detailed status
        const detailedStatus = await this.uploadsService.getBatchUploadStatusDetailed(jobId, req.user.id);
        
        // Send progress update
        const progressData = {
          type: 'progress',
          data: {
            id: detailedStatus.id,
            status: detailedStatus.status,
            progressPercentage: detailedStatus.progressPercentage,
            currentStep: detailedStatus.currentStep,
            uploadProgress: detailedStatus.uploadProgress,
            processingProgress: detailedStatus.processingProgress,
            estimatedCompletion: detailedStatus.estimatedCompletion,
            processingSpeed: detailedStatus.processingSpeed,
            throughput: detailedStatus.throughput,
            isStuck: detailedStatus.isStuck,
            bottleneck: detailedStatus.bottleneck,
            files: {
              total: detailedStatus.totalFiles,
              uploaded: detailedStatus.uploadedFiles,
              processed: detailedStatus.processedFiles,
              watermarked: detailedStatus.watermarkFiles,
              ocrProcessed: detailedStatus.geminiFiles,
              faceProcessed: detailedStatus.faceFiles,
            },
            errors: {
              watermark: detailedStatus.failedWatermarks,
              ocr: detailedStatus.failedGemini,
              face: detailedStatus.failedFaces,
              recent: detailedStatus.recentErrors.slice(0, 3) // Only last 3 errors for stream
            }
          },
          timestamp: new Date().toISOString()
        };

        res.write(`data: ${JSON.stringify(progressData)}\n\n`);

        // If job is completed or failed, send final event and close
        if (detailedStatus.status === 'COMPLETED' || detailedStatus.status === 'FAILED') {
          setTimeout(() => {
            res.write(`data: ${JSON.stringify({ 
              type: 'finished', 
              status: detailedStatus.status,
              timestamp: new Date().toISOString()
            })}\n\n`);
            res.end();
            clearInterval(intervalId);
            isClientConnected = false;
          }, 2000); // Wait 2 seconds before closing
        }

      } catch (error) {
        this.logger.error(`Error in progress stream for batch ${jobId}:`, error);
        res.write(`data: ${JSON.stringify({ 
          type: 'error', 
          message: 'Internal server error',
          timestamp: new Date().toISOString()
        })}\n\n`);
      }
    };

    // Send updates every 3 seconds
    intervalId = setInterval(sendProgressUpdate, 3000);

    // Send initial update immediately
    sendProgressUpdate();

    // Handle client disconnect
    req.on('close', () => {
      this.logger.log(`Client disconnected from progress stream for batch ${jobId}`);
      isClientConnected = false;
      clearInterval(intervalId);
      res.end();
    });

    req.on('aborted', () => {
      this.logger.log(`Client aborted progress stream for batch ${jobId}`);
      isClientConnected = false;
      clearInterval(intervalId);
      res.end();
    });

    // Cleanup after 30 minutes
    setTimeout(() => {
      if (isClientConnected) {
        this.logger.log(`Progress stream timeout for batch ${jobId}`);
        res.write(`data: ${JSON.stringify({ 
          type: 'timeout', 
          message: 'Stream timeout after 30 minutes',
          timestamp: new Date().toISOString()
        })}\n\n`);
        res.end();
        clearInterval(intervalId);
        isClientConnected = false;
      }
    }, 30 * 60 * 1000); // 30 minutes
  }
}