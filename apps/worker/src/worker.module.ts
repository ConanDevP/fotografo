import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';

import { ProcessPhotoProcessor } from './queues/process-photo.processor';
import { ProcessFaceProcessor } from './queues/process-face.processor';
import { SendBibEmailProcessor } from './queues/send-bib-email.processor';
import { ReprocessPhotoProcessor } from './queues/reprocess-photo.processor';
import { InferBibsProcessor } from './queues/infer-bibs.processor';

// Services
import { PrismaService } from '../../api/src/common/services/prisma.service';
import { CloudinaryService } from '../../api/src/common/services/cloudinary.service';
import { R2Service } from '../../api/src/common/services/r2.service';
import { SharpTransformService } from '../../api/src/common/services/sharp-transform.service';
import { StorageService } from '../../api/src/common/services/storage.service';
import { OcrGeminiService } from './services/ocr-gemini.service';


import { FaceApiService } from './services/face-api.service';
import { PythonFaceApiService } from './services/python-face-api.service';
import { ImagesService } from './services/images.service';
import { MailService } from './services/mail.service';
import { SpatialMatchingService } from './services/spatial-matching.service';
import { AthleteSignatureService } from './services/athlete-signature.service';
import { FaceKnnService } from './services/face-knn.service';
import { RescueJobsService } from './services/rescue-jobs.service';
import { BatchProgressService } from './services/batch-progress.service';
import { validateEnvironment } from '../../api/src/common/config/validate-environment';

import { QUEUES } from '@shared/constants';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnvironment,
    }),
    BullModule.forRoot({
      connection: (() => {
        if (!process.env.REDIS_URL) {
          throw new Error('REDIS_URL is required! No local Redis allowed.');
        }
        const url = new URL(process.env.REDIS_URL);
        const config = {
          host: url.hostname,
          port: parseInt(url.port) || 6379,
          password: url.password || undefined,
        };
        return config;
      })(),
      defaultJobOptions: {
        removeOnComplete: 100,
        removeOnFail: 50,
      },
    }),
    BullModule.registerQueue(
      { name: QUEUES.PROCESS_PHOTO },
      { name: QUEUES.PROCESS_FACE },
      { name: QUEUES.SEND_BIB_EMAIL },
      { name: QUEUES.REPROCESS_PHOTO },
      { name: QUEUES.INFER_BIBS },
    ),
  ],
  providers: [
    ProcessPhotoProcessor,
    ProcessFaceProcessor,
    SendBibEmailProcessor,
    ReprocessPhotoProcessor,
    InferBibsProcessor,
    PrismaService,
    CloudinaryService,
    R2Service,
    SharpTransformService,
    StorageService,
    OcrGeminiService,
    FaceApiService,
    PythonFaceApiService,
    ImagesService,
    MailService,
    SpatialMatchingService,
    AthleteSignatureService,
    FaceKnnService,
    RescueJobsService,
    BatchProgressService,
  ],
})
export class WorkerModule {}
