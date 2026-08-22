import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import IORedis from 'ioredis';
import { createHash } from 'crypto';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private connection: IORedis;

  constructor(private configService: ConfigService) {}

  onModuleInit() {
    const redisUrl = this.configService.get('REDIS_URL');

    const options = {
      maxRetriesPerRequest: 3,
      retryStrategy: (times: number) => {
        const delay = Math.min(times * 50, 2000);
        this.logger.warn(`Reconnecting to Redis (attempt ${times})`);
        return delay;
      },
      reconnectOnError: (err: Error) => {
        this.logger.error('Redis connection error:', err.message);
        return true;
      },
      enableOfflineQueue: true,
      family: 4,
    };

    if (redisUrl) {
      this.connection = new IORedis(redisUrl, options);
    } else {
      this.connection = new IORedis({
        host: this.configService.get('REDIS_HOST', 'localhost'),
        port: this.configService.get('REDIS_PORT', 6379),
        password: this.configService.get('REDIS_PASSWORD'),
        ...options,
      });
    }

    this.connection.on('connect', () => {
      this.logger.log('Redis connected');
    });

    this.connection.on('error', (err) => {
      this.logger.error('Redis error:', err.message);
    });

    this.connection.on('reconnecting', () => {
      this.logger.warn('Redis reconnecting...');
    });
  }

  async onModuleDestroy() {
    await this.connection?.disconnect();
  }

  async setRefreshToken(token: string, userId: string, expiresAt: number): Promise<void> {
    const key = this.refreshTokenKey(token);
    const ttlSeconds = Math.floor((expiresAt - Date.now()) / 1000);
    
    if (ttlSeconds > 0) {
      await this.connection.setex(key, ttlSeconds, JSON.stringify({ userId, expiresAt }));
    }
  }

  async getRefreshToken(token: string): Promise<{ userId: string; expiresAt: number } | null> {
    const key = this.refreshTokenKey(token);
    const data = await this.connection.get(key);
    
    if (!data) {
      return null;
    }
    
    return JSON.parse(data);
  }

  async consumeRefreshToken(token: string): Promise<{ userId: string; expiresAt: number } | null> {
    const data = await this.connection.getdel(this.refreshTokenKey(token));
    if (!data) return null;
    return JSON.parse(data);
  }

  async deleteRefreshToken(token: string): Promise<void> {
    const key = this.refreshTokenKey(token);
    await this.connection.del(key);
  }

  private refreshTokenKey(token: string) {
    return `refresh_token:${createHash('sha256').update(token).digest('hex')}`;
  }
}
