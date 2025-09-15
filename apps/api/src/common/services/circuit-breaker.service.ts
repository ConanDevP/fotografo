import { Injectable, Logger } from '@nestjs/common';

interface CircuitBreakerState {
  failures: number;
  lastFailureTime: number;
  state: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
}

@Injectable()
export class CircuitBreakerService {
  private readonly logger = new Logger(CircuitBreakerService.name);
  private breakers = new Map<string, CircuitBreakerState>();
  
  // Configuración por servicio
  private config = {
    gemini: { threshold: 10, timeout: 60000 }, // 10 fallos, 1 min timeout
    cloudinary: { threshold: 15, timeout: 30000 }, // 15 fallos, 30s timeout
    faceapi: { threshold: 8, timeout: 45000 }, // 8 fallos, 45s timeout
    default: { threshold: 5, timeout: 30000 }
  };

  async execute<T>(
    serviceName: string, 
    operation: () => Promise<T>,
    fallback?: () => Promise<T>
  ): Promise<T> {
    const breaker = this.getBreaker(serviceName);
    const config = this.config[serviceName] || this.config.default;

    // Check circuit breaker state
    if (breaker.state === 'OPEN') {
      if (Date.now() - breaker.lastFailureTime > config.timeout) {
        breaker.state = 'HALF_OPEN';
        this.logger.log(`Circuit breaker ${serviceName}: OPEN -> HALF_OPEN`);
      } else {
        this.logger.warn(`Circuit breaker ${serviceName}: BLOCKED (${breaker.failures} failures)`);
        if (fallback) {
          return await fallback();
        }
        throw new Error(`Service ${serviceName} is currently unavailable`);
      }
    }

    try {
      const result = await operation();
      
      // Success - reset breaker
      if (breaker.state === 'HALF_OPEN') {
        breaker.state = 'CLOSED';
        breaker.failures = 0;
        this.logger.log(`Circuit breaker ${serviceName}: HALF_OPEN -> CLOSED`);
      }
      
      return result;
    } catch (error) {
      breaker.failures++;
      breaker.lastFailureTime = Date.now();
      
      if (breaker.failures >= config.threshold) {
        breaker.state = 'OPEN';
        this.logger.error(`Circuit breaker ${serviceName}: CLOSED -> OPEN (${breaker.failures} failures)`);
      }
      
      this.logger.error(`Circuit breaker ${serviceName}: Failure ${breaker.failures}/${config.threshold}`);
      
      if (fallback && breaker.state === 'OPEN') {
        this.logger.log(`Circuit breaker ${serviceName}: Using fallback`);
        return await fallback();
      }
      
      throw error;
    }
  }

  private getBreaker(serviceName: string): CircuitBreakerState {
    if (!this.breakers.has(serviceName)) {
      this.breakers.set(serviceName, {
        failures: 0,
        lastFailureTime: 0,
        state: 'CLOSED'
      });
    }
    return this.breakers.get(serviceName)!;
  }

  getStatus(serviceName?: string) {
    if (serviceName) {
      return this.breakers.get(serviceName);
    }
    return Object.fromEntries(this.breakers);
  }

  reset(serviceName: string) {
    const breaker = this.breakers.get(serviceName);
    if (breaker) {
      breaker.failures = 0;
      breaker.state = 'CLOSED';
      this.logger.log(`Circuit breaker ${serviceName}: RESET`);
    }
  }
}