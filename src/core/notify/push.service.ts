import { readFileSync } from 'node:fs';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { type App, cert, initializeApp } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { ENV, type Env } from '../config/env.js';

export interface PushMessage {
  readonly token: string;
  readonly title: string;
  readonly body: string;
  readonly data?: Readonly<Record<string, string>>;
}

export type PushOutcome = 'SENT' | 'INVALID_TOKEN' | 'FAILED' | 'DISABLED';

/** FCM push (Firebase is used for push only). Logs instead of sending when not configured. */
@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  private readonly app: App | null;

  constructor(@Inject(ENV) env: Env) {
    const json = env.FCM_SERVICE_ACCOUNT_JSON ?? (env.FCM_SERVICE_ACCOUNT_PATH ? readFileSync(env.FCM_SERVICE_ACCOUNT_PATH, 'utf8') : null);
    this.app = json ? initializeApp({ credential: cert(JSON.parse(json)) }, 'push') : null;
  }

  async send(message: PushMessage): Promise<PushOutcome> {
    if (!this.app) {
      this.logger.log(`Push (disabled): ${message.title}`);
      return 'DISABLED';
    }
    try {
      await getMessaging(this.app).send({
        token: message.token,
        notification: { title: message.title, body: message.body },
        data: message.data ? { ...message.data } : undefined,
        android: { priority: 'high' },
      });
      return 'SENT';
    } catch (error: unknown) {
      const code = (error as { code?: string }).code ?? '';
      if (code.includes('registration-token-not-registered') || code.includes('invalid-argument')) {
        return 'INVALID_TOKEN';
      }
      this.logger.warn(`Push failed: ${code}`);
      return 'FAILED';
    }
  }
}
