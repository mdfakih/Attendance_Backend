import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { AppError } from '../http/app-error.js';
import { REDIS } from './redis.module.js';

/** Small JSON cache + fixed-window rate limiter on Redis. */
@Injectable()
export class CacheService {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async getJson<T>(key: string): Promise<T | null> {
    const raw = await this.redis.get(key);
    return raw === null ? null : (JSON.parse(raw) as T);
  }

  async setJson(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    await this.redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  }

  async remember<T>(key: string, ttlSeconds: number, load: () => Promise<T>): Promise<T> {
    const cached = await this.getJson<T>(key);
    if (cached !== null) {
      return cached;
    }
    const value = await load();
    if (value !== null && value !== undefined) {
      await this.setJson(key, value, ttlSeconds);
    }
    return value;
  }

  async del(...keys: string[]): Promise<void> {
    if (keys.length > 0) {
      await this.redis.del(...keys);
    }
  }

  /** Stores a single-use value; `take` returns it once and deletes it. */
  async putOnce(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    await this.setJson(key, value, ttlSeconds);
  }

  async take<T>(key: string): Promise<T | null> {
    const raw = await this.redis.getdel(key);
    return raw === null ? null : (JSON.parse(raw) as T);
  }

  /** Counts hits in a fixed window; returns the new count. */
  async hit(key: string, windowSeconds: number): Promise<number> {
    const count = await this.redis.incr(key);
    if (count === 1) {
      await this.redis.expire(key, windowSeconds);
    }
    return count;
  }

  async count(key: string): Promise<number> {
    const raw = await this.redis.get(key);
    return raw === null ? 0 : Number(raw);
  }

  /** Throws RATE_LIMITED when the key exceeds `limit` hits in the window. */
  async limit(key: string, limit: number, windowSeconds: number): Promise<void> {
    const count = await this.hit(`rl:${key}`, windowSeconds);
    if (count > limit) {
      throw new AppError('RATE_LIMITED');
    }
  }
}
