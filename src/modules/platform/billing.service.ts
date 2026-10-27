import { Injectable } from '@nestjs/common';
import type { PlanInput, RecordPaymentInput, UpdateSubscriptionInput } from '@attendance/contracts';
import { Decimal } from 'decimal.js';
import { AuditService } from '../../core/audit/audit.service.js';
import { requirePlatform } from '../../core/context/request-context.js';
import { DbService } from '../../core/database/db.service.js';
import { AppError, notFound } from '../../core/http/app-error.js';
import { dateOnly, iso, money } from '../../common/serialize.js';
import { addDays, localDateOf, toDbDate } from '../../engines/time/dates.js';

export interface CreateChargeInput {
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly billableEmployees?: number;
  readonly gstRate?: number;
  readonly invoiceNo?: string;
  readonly notes?: string;
}

/** Manual billing: plans, charges (amount due per period) and recorded payments. */
@Injectable()
export class BillingService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  listPlans() {
    return this.db.platform.plan
      .findMany({ orderBy: [{ active: 'desc' }, { code: 'asc' }] })
      .then((plans) => plans.map((p) => ({ ...p, pricePerEmployee: money(p.pricePerEmployee) })));
  }

  async createPlan(input: PlanInput) {
    const latest = await this.db.platform.plan.findFirst({ where: { code: input.code }, orderBy: { version: 'desc' } });
    const plan = await this.db.platform.plan.create({
      data: { ...input, version: (latest?.version ?? 0) + 1, pricePerEmployee: new Decimal(input.pricePerEmployee) },
    });
    await this.audit.record({ action: 'plan.create', entityType: 'plan', entityId: plan.id, after: plan, tenantId: null });
    return { ...plan, pricePerEmployee: money(plan.pricePerEmployee) };
  }

  async setPlanActive(planId: string, active: boolean) {
    const plan = await this.db.platform.plan.update({ where: { id: planId }, data: { active } });
    return { ...plan, pricePerEmployee: money(plan.pricePerEmployee) };
  }

  async updateSubscription(tenantId: string, input: UpdateSubscriptionInput) {
    const sub = await this.db.platform.subscription.findUnique({ where: { tenantId } });
    if (!sub) {
      throw notFound('Subscription');
    }
    const updated = await this.db.platform.subscription.update({
      where: { tenantId },
      data: {
        planId: input.planId,
        status: input.status,
        currentPeriodStart: input.currentPeriodStart ? toDbDate(input.currentPeriodStart) : undefined,
        currentPeriodEnd: input.currentPeriodEnd ? toDbDate(input.currentPeriodEnd) : undefined,
        nextDueDate: input.dueDate === undefined ? undefined : input.dueDate ? toDbDate(input.dueDate) : null,
        priceOverride:
          input.pricePerEmployeeOverride === undefined
            ? undefined
            : input.pricePerEmployeeOverride === null
              ? null
              : new Decimal(input.pricePerEmployeeOverride),
        notes: input.notes,
      },
    });
    if (input.status && input.status !== sub.status) {
      await this.db.platform.subscriptionEvent.create({
        data: {
          tenantId,
          subscriptionId: sub.id,
          eventType: 'STATUS_CHANGED',
          fromStatus: sub.status,
          toStatus: input.status,
          actorType: 'PLATFORM_USER',
          actorId: requirePlatform().platformUserId,
        },
      });
    }
    await this.audit.record({ action: 'billing.subscription.update', entityType: 'subscription', entityId: sub.id, before: sub, after: updated, tenantId });
    return { status: updated.status };
  }

  async createCharge(tenantId: string, input: CreateChargeInput) {
    const sub = await this.db.platform.subscription.findUnique({ where: { tenantId }, include: { plan: true } });
    if (!sub) {
      throw notFound('Subscription');
    }
    const billable =
      input.billableEmployees ??
      Math.max(
        sub.plan.minBillableEmployees,
        await this.db.platform.employee.count({ where: { tenantId, status: { in: ['ACTIVE', 'INVITED'] } } }),
      );
    const unitPrice = sub.priceOverride ?? sub.plan.pricePerEmployee;
    const discount = new Decimal(1).minus(new Decimal(sub.discountPct).div(100));
    const subtotal = new Decimal(unitPrice).mul(billable).mul(discount).toDecimalPlaces(2);
    const gstRate = new Decimal(input.gstRate ?? 18);
    const gstAmount = subtotal.mul(gstRate).div(100).toDecimalPlaces(2);
    const charge = await this.db.platform.subscriptionCharge.create({
      data: {
        tenantId,
        subscriptionId: sub.id,
        periodStart: toDbDate(input.periodStart),
        periodEnd: toDbDate(input.periodEnd),
        billableEmployees: billable,
        unitPrice,
        subtotal,
        gstRate,
        gstAmount,
        total: subtotal.plus(gstAmount),
        invoiceNo: input.invoiceNo,
        notes: input.notes,
        createdByActor: 'PLATFORM_USER',
        createdById: requirePlatform().platformUserId,
      },
    });
    await this.audit.record({ action: 'billing.charge.create', entityType: 'charge', entityId: charge.id, after: charge, tenantId });
    return { id: charge.id, total: money(charge.total), status: charge.status };
  }

  async issueCharge(chargeId: string, dueDate?: string) {
    const charge = await this.db.platform.subscriptionCharge.findUnique({ where: { id: chargeId }, include: { subscription: { include: { plan: true } } } });
    if (!charge) {
      throw notFound('Charge');
    }
    if (charge.status !== 'DRAFT') {
      throw new AppError('CONFLICT', 'Only draft charges can be issued.');
    }
    const due = dueDate ?? addDays(localDateOf(new Date(), 'Asia/Kolkata'), charge.subscription.plan.paymentTermsDays);
    await this.db.platform.subscriptionCharge.update({
      where: { id: chargeId },
      data: { status: 'DUE', issuedAt: new Date(), dueDate: toDbDate(due) },
    });
    await this.db.platform.subscription.update({ where: { id: charge.subscriptionId }, data: { nextDueDate: toDbDate(due) } });
    await this.audit.record({ action: 'billing.charge.issue', entityType: 'charge', entityId: chargeId, tenantId: charge.tenantId });
    return { id: chargeId, status: 'DUE', dueDate: due };
  }

  async voidCharge(chargeId: string, reason: string) {
    const charge = await this.db.platform.subscriptionCharge.update({ where: { id: chargeId }, data: { status: 'VOID', notes: reason } });
    await this.audit.record({ action: 'billing.charge.void', entityType: 'charge', entityId: chargeId, reason, tenantId: charge.tenantId });
    return { id: chargeId, status: 'VOID' };
  }

  async recordPayment(tenantId: string, input: RecordPaymentInput & { chargeId?: string }) {
    const recordedById = requirePlatform().platformUserId;
    const result = await this.db.platform.$transaction(async (tx) => {
      const payment = await tx.payment.create({
        data: {
          tenantId,
          chargeId: input.chargeId ?? null,
          amount: new Decimal(input.amount),
          method: input.method,
          referenceNo: input.referenceNo,
          receivedOn: toDbDate(input.receivedOn),
          recordedById,
          notes: input.notes,
        },
      });
      if (input.chargeId) {
        const charge = await tx.subscriptionCharge.findFirst({ where: { id: input.chargeId, tenantId } });
        if (!charge) {
          throw notFound('Charge');
        }
        const paid = new Decimal(charge.amountPaid).plus(input.amount);
        const settled = paid.greaterThanOrEqualTo(charge.total);
        await tx.subscriptionCharge.update({
          where: { id: charge.id },
          data: { amountPaid: paid, status: settled ? 'PAID' : charge.status, paidAt: settled ? new Date() : null },
        });
      }
      const sub = await tx.subscription.findUnique({ where: { tenantId } });
      if (sub && (sub.status === 'PAST_DUE' || sub.status === 'TRIALING')) {
        await tx.subscription.update({ where: { tenantId }, data: { status: 'ACTIVE' } });
        await tx.tenant.update({ where: { id: tenantId }, data: { status: 'ACTIVE' } });
      }
      await this.audit.record({ action: 'billing.payment.record', entityType: 'payment', entityId: payment.id, after: payment, tenantId }, tx);
      return payment;
    });
    return { id: result.id, amount: money(result.amount) };
  }

  async overview() {
    const [byStatus, overdue, activeEmployees, recentPayments] = await Promise.all([
      this.db.platform.tenant.groupBy({ by: ['status'], _count: { _all: true } }),
      this.db.platform.subscriptionCharge.findMany({
        where: { status: { in: ['DUE', 'OVERDUE'] } },
        orderBy: { dueDate: 'asc' },
        take: 50,
      }),
      this.db.platform.employee.count({ where: { status: 'ACTIVE' } }),
      this.db.platform.payment.findMany({ orderBy: { createdAt: 'desc' }, take: 10 }),
    ]);
    const tenants = await this.db.platform.tenant.findMany({
      where: { id: { in: [...new Set([...overdue.map((c) => c.tenantId), ...recentPayments.map((p) => p.tenantId)])] } },
      select: { id: true, displayName: true },
    });
    const name = new Map(tenants.map((t) => [t.id, t.displayName]));
    const outstanding = overdue.reduce((acc, c) => acc.plus(c.total).minus(c.amountPaid), new Decimal(0));
    return {
      tenantsByStatus: Object.fromEntries(byStatus.map((s) => [s.status, s._count._all])),
      activeEmployees,
      outstanding: money(outstanding),
      dueCharges: overdue.map((c) => ({
        id: c.id,
        tenantId: c.tenantId,
        tenantName: name.get(c.tenantId) ?? '',
        total: money(c.total),
        amountPaid: money(c.amountPaid),
        dueDate: dateOnly(c.dueDate),
        status: c.status,
      })),
      recentPayments: recentPayments.map((p) => ({
        id: p.id,
        tenantName: name.get(p.tenantId) ?? '',
        amount: money(p.amount),
        method: p.method,
        receivedOn: dateOnly(p.receivedOn),
        createdAt: iso(p.createdAt),
      })),
    };
  }
}
