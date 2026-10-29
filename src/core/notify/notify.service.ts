import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../database/db.service.js';
import { type MailMessage, MailService } from './mail.service.js';
import { PushService } from './push.service.js';

export interface EmployeeNotice {
  readonly tenantId: string;
  readonly employeeId: string;
  readonly title: string;
  readonly body: string;
  readonly data?: Readonly<Record<string, string>>;
}

/**
 * Sends notifications inline (no queue). Delivery problems are logged and never fail the
 * request that caused them; the in-app notification row is the durable record.
 */
@Injectable()
export class NotifyService {
  private readonly logger = new Logger(NotifyService.name);

  constructor(
    private readonly db: DbService,
    private readonly push: PushService,
    private readonly mail: MailService,
  ) {}

  /** Saves an in-app notification and pushes it when the employee's phone has a token. Needs tenant context. */
  async employee(notice: EmployeeNotice): Promise<void> {
    try {
      const binding = await this.db.tenant.deviceBinding.findFirst({ where: { employeeId: notice.employeeId, status: 'ACTIVE' } });
      let outcome: string = 'NONE';
      if (binding?.fcmToken) {
        outcome = await this.push.send({ token: binding.fcmToken, title: notice.title, body: notice.body, data: notice.data });
        if (outcome === 'INVALID_TOKEN') {
          await this.db.tenant.deviceBinding.update({ where: { id: binding.id }, data: { fcmToken: null } });
        }
      }
      await this.db.tenant.notification.create({
        data: {
          tenantId: notice.tenantId,
          recipientType: 'EMPLOYEE',
          recipientId: notice.employeeId,
          type: notice.data?.['type'] ?? 'GENERAL',
          title: notice.title,
          body: notice.body,
          data: notice.data ?? {},
          pushStatus: outcome === 'SENT' ? 'SENT' : outcome === 'NONE' || outcome === 'DISABLED' ? 'NONE' : 'FAILED',
          sentAt: outcome === 'SENT' ? new Date() : null,
        },
      });
    } catch (error: unknown) {
      this.logger.error(`Employee notice "${notice.title}" for ${notice.employeeId} failed: ${this.message(error)}`);
    }
  }

  /** True when the mail server accepted the message. */
  async email(message: MailMessage): Promise<boolean> {
    try {
      await this.mail.send(message);
      return true;
    } catch (error: unknown) {
      this.logger.error(`Email "${message.subject}" failed: ${this.message(error)}`);
      return false;
    }
  }

  private message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
