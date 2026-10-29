import { Injectable, Logger } from '@nestjs/common';
import type { ExportRequestInput } from '@attendance/contracts';
import { AuditService } from '../../core/audit/audit.service.js';
import { employeeScopeWhere } from '../../core/auth/scope.js';
import { requireContext, requireTenantId, requireTenantUser } from '../../core/context/request-context.js';
import { DbService } from '../../core/database/db.service.js';
import { AppError, notFound } from '../../core/http/app-error.js';
import { StorageService } from '../../core/storage/storage.service.js';
import { iso } from '../../common/serialize.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { monthRange } from '../../engines/time/dates.js';
import { AttendanceSettleService } from '../attendance/attendance-settle.service.js';
import { PayService } from '../pay/pay.service.js';
import { ExportGenerators, type GeneratedFile } from './generators.js';

const EXPORT_TTL_DAYS = 7;
/** Longer than any function or request timeout, so a job still open after this was abandoned. */
const ABANDONED_AFTER_MS = 15 * 60_000;

export interface ScopeSnapshot {
  readonly roleKind: 'ADMIN' | 'MANAGER';
  readonly branchIds: readonly string[];
  readonly departmentIds: readonly string[];
}

@Injectable()
export class ExportsService {
  private readonly logger = new Logger(ExportsService.name);

  constructor(
    private readonly db: DbService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly generators: ExportGenerators,
    private readonly settle: AttendanceSettleService,
    private readonly pay: PayService,
  ) {}

  async request(input: ExportRequestInput) {
    const user = requireTenantUser();
    const scope: ScopeSnapshot = { roleKind: user.roleKind, branchIds: user.branchIds, departmentIds: user.departmentIds };
    const needsMonth = ['ATTENDANCE_REGISTER', 'SALARY_REGISTER', 'LEAVE_REGISTER'].includes(input.type);
    if (needsMonth && !input.month) throw new AppError('VALIDATION_FAILED', 'Choose a month.');
    if (input.type === 'ATTENDANCE_DAILY' && !input.date) throw new AppError('VALIDATION_FAILED', 'Choose a date.');
    if (input.type === 'PUNCH_LOG' && !(input.from && input.to)) throw new AppError('VALIDATION_FAILED', 'Choose a date range.');
    const job = await this.db.tenant.exportJob.create({
      data: {
        tenantId: requireTenantId(),
        requestedById: user.membershipId,
        exportType: input.type,
        format: input.format,
        params: { ...input, scope } as unknown as Prisma.InputJsonValue,
        expiresAt: new Date(Date.now() + EXPORT_TTL_DAYS * 86_400_000),
      },
    });
    // Generated inline within the request. A failure is recorded on the job, not thrown.
    let prepared = true;
    try {
      await this.prepare(input);
    } catch (error: unknown) {
      prepared = false;
      await this.fail(job.id, error);
    }
    if (prepared) {
      try {
        await this.run(job.id);
      } catch (error: unknown) {
        this.logger.warn(`Export ${job.id} did not complete: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const done = await this.db.tenant.exportJob.findUniqueOrThrow({ where: { id: job.id } });
    return { id: done.id, status: done.status, error: done.error };
  }

  /** Brings the stored days and pay summaries the export reads up to date, within the requester's scope. */
  private async prepare(input: ExportRequestInput): Promise<void> {
    if (input.type === 'ATTENDANCE_REGISTER' && input.month) {
      const { start, end } = monthRange(input.month);
      await this.settle.settle(start, end, employeeScopeWhere());
    } else if (input.type === 'SALARY_REGISTER' && input.month) {
      await this.pay.settleMonth(input.month, employeeScopeWhere());
    } else if (input.type === 'ATTENDANCE_DAILY' && input.date) {
      await this.settle.settle(input.date, input.date, employeeScopeWhere());
    }
  }

  private async fail(jobId: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : 'Export failed';
    this.logger.error(`Export ${jobId} failed: ${message}`);
    await this.db.tenant.exportJob.update({ where: { id: jobId }, data: { status: 'FAILED', error: message.slice(0, 500), finishedAt: new Date() } });
  }

  async list() {
    // A request cut off mid-generation (e.g. a function timeout) leaves its job open; close it out.
    await this.db.tenant.exportJob.updateMany({
      where: { requestedById: requireTenantUser().membershipId, status: { in: ['QUEUED', 'RUNNING'] }, createdAt: { lt: new Date(Date.now() - ABANDONED_AFTER_MS) } },
      data: { status: 'FAILED', error: 'The export did not finish. Please try again.', finishedAt: new Date() },
    });
    const rows = await this.db.tenant.exportJob.findMany({ where: { requestedById: requireTenantUser().membershipId }, orderBy: { createdAt: 'desc' }, take: 50 });
    return rows.map((j) => ({
      id: j.id,
      type: j.exportType,
      format: j.format,
      status: j.status,
      progress: j.progress,
      error: j.error,
      params: j.params,
      createdAt: iso(j.createdAt),
      finishedAt: iso(j.finishedAt),
      expiresAt: iso(j.expiresAt),
      ready: j.status === 'DONE' && !!j.fileId && (!j.expiresAt || j.expiresAt > new Date()),
    }));
  }

  async downloadUrl(jobId: string): Promise<string> {
    const job = await this.db.tenant.exportJob.findUnique({ where: { id: jobId } });
    if (!job || job.requestedById !== requireTenantUser().membershipId || !job.fileId) throw notFound('Export');
    const file = await this.db.tenant.storedFile.findUnique({ where: { id: job.fileId } });
    if (!file || file.deletedAt) throw notFound('Export file');
    await this.audit.record({ action: 'export.download', entityType: 'export_job', entityId: jobId });
    return this.storage.presignGet(file.objectKey, 120, file.fileName);
  }

  /** Runs inside the requester's own request, so the tenant context already carries their scope. */
  async run(jobId: string): Promise<void> {
    const job = await this.db.tenant.exportJob.findUnique({ where: { id: jobId } });
    if (!job || job.status === 'DONE') return;
    await this.db.tenant.exportJob.update({ where: { id: jobId }, data: { status: 'RUNNING', startedAt: new Date(), progress: 10 } });
    try {
      const params = job.params as unknown as ExportRequestInput & { scope: ScopeSnapshot };
      const generated: GeneratedFile = await this.generators.generate(params);
      const key = `t/${job.tenantId}/exports/${job.id}/${generated.fileName}`;
      await this.storage.put(key, generated.buffer, generated.mime);
      const file = await this.db.tenant.storedFile.create({
        data: {
          tenantId: job.tenantId,
          bucket: this.storage.bucket,
          objectKey: key,
          fileName: generated.fileName,
          purpose: 'EXPORT',
          mime: generated.mime,
          sizeBytes: BigInt(generated.buffer.length),
          createdByActor: 'TENANT_USER',
          createdById: job.requestedById,
          expiresAt: job.expiresAt,
        },
      });
      await this.db.tenant.exportJob.update({ where: { id: jobId }, data: { status: 'DONE', progress: 100, fileId: file.id, finishedAt: new Date() } });
      await this.db.tenant.notification.create({
        data: {
          tenantId: job.tenantId,
          recipientType: 'TENANT_USER',
          recipientId: job.requestedById,
          type: 'EXPORT_READY',
          title: 'Your export is ready',
          body: generated.fileName,
          data: { exportJobId: job.id },
        },
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Export failed';
      this.logger.error(`Export ${jobId} failed: ${message}`);
      await this.db.tenant.exportJob.update({ where: { id: jobId }, data: { status: 'FAILED', error: message.slice(0, 500), finishedAt: new Date() } });
      throw error;
    }
  }

  scopeContext(scope: ScopeSnapshot) {
    const ctx = requireContext();
    return {
      ...ctx,
      tenantUser: {
        membershipId: 'export',
        userId: 'export',
        roleId: 'export',
        roleKind: scope.roleKind,
        permissions: {},
        branchIds: scope.branchIds,
        departmentIds: scope.departmentIds,
      },
    };
  }
}
