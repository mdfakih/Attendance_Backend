import { Injectable, Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { AuditService } from '../core/audit/audit.service.js';
import { runAsTenant } from '../core/context/request-context.js';
import { DbService } from '../core/database/db.service.js';
import { MailService } from '../core/notify/mail.service.js';
import { PushService } from '../core/notify/push.service.js';
import type { EmailJob, PushJob } from '../core/queue/queues.js';
import { ActivationCodesService } from '../modules/employees/activation-codes.service.js';

interface ActivationEmailJob {
  readonly tenantId: string;
  readonly employeeId: string;
}

@Injectable()
export class NotifyProcessor {
  private readonly logger = new Logger(NotifyProcessor.name);

  constructor(
    private readonly db: DbService,
    private readonly push: PushService,
    private readonly mail: MailService,
    private readonly codes: ActivationCodesService,
    private readonly audit: AuditService,
  ) {}

  async handle(job: Job): Promise<void> {
    switch (job.name) {
      case 'push':
        return this.sendPush(job.data as PushJob);
      case 'email':
        return this.sendEmail(job.data as EmailJob);
      case 'activation-email':
        return this.activationEmail(job.data as ActivationEmailJob);
      default:
        this.logger.warn(`Unknown notify job ${job.name}`);
    }
  }

  private sendPush(data: PushJob): Promise<void> {
    return runAsTenant(data.tenantId, async () => {
      const binding = await this.db.tenant.deviceBinding.findFirst({ where: { employeeId: data.employeeId, status: 'ACTIVE' } });
      let outcome: string = 'NONE';
      if (binding?.fcmToken) {
        outcome = await this.push.send({ token: binding.fcmToken, title: data.title, body: data.body, data: data.data });
        if (outcome === 'INVALID_TOKEN') {
          await this.db.tenant.deviceBinding.update({ where: { id: binding.id }, data: { fcmToken: null } });
        }
      }
      await this.db.tenant.notification.create({
        data: {
          tenantId: data.tenantId,
          recipientType: 'EMPLOYEE',
          recipientId: data.employeeId,
          type: data.data?.['type'] ?? 'GENERAL',
          title: data.title,
          body: data.body,
          data: data.data ?? {},
          pushStatus: outcome === 'SENT' ? 'SENT' : outcome === 'NONE' || outcome === 'DISABLED' ? 'NONE' : 'FAILED',
          sentAt: outcome === 'SENT' ? new Date() : null,
        },
      });
    });
  }

  private async sendEmail(data: EmailJob): Promise<void> {
    await this.mail.send({ to: data.to, subject: data.subject, text: data.text });
  }

  private activationEmail(data: ActivationEmailJob): Promise<void> {
    return runAsTenant(data.tenantId, async () => {
      const employee = await this.db.tenant.employee.findUnique({ where: { id: data.employeeId } });
      if (!employee?.email) return;
      const code = await this.codes.reveal(employee.id, 'ACTIVATION');
      if (!code) return;
      const tenant = await this.db.platform.tenant.findUniqueOrThrow({ where: { id: data.tenantId }, select: { displayName: true } });
      await this.mail.send({
        to: employee.email,
        subject: `Your ${tenant.displayName} attendance app code`,
        text: [
          `Hello ${employee.fullName},`,
          '',
          `Install the attendance app and sign in with your mobile number ${employee.phoneE164} and this one-time code:`,
          '',
          `    ${code.formatted}`,
          '',
          `The code works once and expires on ${code.expiresAt.toISOString().slice(0, 10)}. Do not share it.`,
        ].join('\n'),
      });
      await this.audit.record({ action: 'activation_code.emailed', entityType: 'employee', entityId: employee.id, tenantId: data.tenantId });
    });
  }
}
