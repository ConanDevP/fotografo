import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import IORedis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private connection: IORedis;

  constructor(private configService: ConfigService) {}

  onModuleInit() {
    const redisUrl = this.configService.get('REDIS_URL');
    
    if (redisUrl) {
      this.connection = new IORedis(redisUrl, {
        maxRetriesPerRequest: 3,
        lazyConnect: true,
        family: 4,
      });
    } else {
      this.connection = new IORedis({
        host: this.configService.get('REDIS_HOST', 'localhost'),
        port: this.configService.get('REDIS_PORT', 6379),
        password: this.configService.get('REDIS_PASSWORD'),
        maxRetriesPerRequest: 3,
        lazyConnect: true,
        family: 4,
      });
    }
  }

  async onModuleDestroy() {
    await this.connection?.disconnect();
  }

  async setRefreshToken(token: string, userId: string, expiresAt: number): Promise<void> {
    const key = `refresh_token:${token}`;
    const ttlSeconds = Math.floor((expiresAt - Date.now()) / 1000);
    
    if (ttlSeconds > 0) {
      await this.connection.setex(key, ttlSeconds, JSON.stringify({ userId, expiresAt }));
    }
  }

  async getRefreshToken(token: string): Promise<{ userId: string; expiresAt: number } | null> {
    const key = `refresh_token:${token}`;
    const data = await this.connection.get(key);
    
    if (!data) {
      return null;
    }
    
    return JSON.parse(data);
  }

  async deleteRefreshToken(token: string): Promise<void> {
    const key = `refresh_token:${token}`;
    await this.connection.del(key);
  }
}