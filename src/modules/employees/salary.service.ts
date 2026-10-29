import { Injectable } from '@nestjs/common';
import type { SalaryInput } from '@attendance/contracts';
import { Decimal } from 'decimal.js';
import { AuditService } from '../../core/audit/audit.service.js';
import { isInScope } from '../../core/auth/scope.js';
import { requireTenantId, requireTenantUser } from '../../core/context/request-context.js';
import { DbService } from '../../core/database/db.service.js';
import { AppError, notFound } from '../../core/http/app-error.js';
import { addDays, monthOf, toDbDate } from '../../engines/time/dates.js';

/** Effective-dated salary revisions. A revision closes the previous open row the day before. */
@Injectable()
export class SalaryService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  async addRevision(employeeId: string, input: SalaryInput) {
    const employee = await this.db.tenant.employee.findUnique({ where: { id: employeeId } });
    if (!employee || !isInScope(employee)) throw notFound('Employee');
    const month = monthOf(input.effectiveFrom);
    const locked = await this.db.tenant.payPeriod.count({
      where: { status: 'LOCKED', month: { gte: toDbDate(`${month}-01`) } },
    });
    if (locked > 0) throw new AppError('PERIOD_LOCKED', 'Salary changes must start in an open month.');
    const from = toDbDate(input.effectiveFrom);
    const created = await this.db.tenant.$transaction(async (tx) => {
      await this.db.lock(tx, `salary:${employeeId}`);
      const later = await tx.employeeSalaryAssignment.count({ where: { employeeId, effectiveFrom: { gte: from } } });
      if (later > 0) throw new AppError('CONFLICT', 'A salary revision already starts on or after this date.');
      await tx.employeeSalaryAssignment.updateMany({
        where: { employeeId, effectiveTo: null },
        data: { effectiveTo: toDbDate(addDays(input.effectiveFrom, -1)) },
      });
      const row = await tx.employeeSalaryAssignment.create({
        data: {
          tenantId: requireTenantId(),
          employeeId,
          salaryBasis: input.basis,
          amount: new Decimal(input.amount),
          effectiveFrom: from,
          otMultiplier: input.otMultiplier ? new Decimal(input.otMultiplier) : null,
          revisionReason: input.revisionReason || 'Salary revision',
          createdById: requireTenantUser().membershipId,
        },
      });
      await this.audit.record({ action: 'salary.assignment.create', entityType: 'employee', entityId: employeeId, after: row }, tx);
      return row;
    });
    // Every open month from the effective date on is recomputed on its next read.
    await this.db.tenant.employeePaySummary.updateMany({
      where: { employeeId, periodStart: { gte: toDbDate(`${month}-01`) }, status: 'OPEN' },
      data: { isStale: true },
    });
    return { id: created.id };
  }
}
