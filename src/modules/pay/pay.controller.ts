import { Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { monthSchema, payAdjustmentSchema, payPeriodLockSchema, payPeriodUnlockSchema, payRegisterQuerySchema, reasonSchema } from '@attendance/contracts';
import { z } from 'zod';
import { AdminOnly, EmployeeApi, RequireFeature, RequirePermission, TenantApi } from '../../core/auth/decorators.js';
import { requireEmployee } from '../../core/context/request-context.js';
import { paged } from '../../core/http/envelope.js';
import { ZBody, ZQuery } from '../../core/http/zod.js';
import { PayService } from './pay.service.js';

@TenantApi()
@RequireFeature('PAY_MONITORING')
@Controller('v1/tenant/pay')
export class PayController {
  constructor(private readonly pay: PayService) {}

  @RequirePermission('PAY', 'view')
  @Get('periods')
  periods() {
    return this.pay.periods();
  }

  @RequirePermission('PAY', 'view')
  @Get('register')
  async register(@ZQuery(payRegisterQuerySchema) q: z.infer<typeof payRegisterQuerySchema>) {
    const { items, total, ...rest } = await this.pay.register(q);
    return { ...rest, items, meta: { page: q.page, pageSize: q.pageSize, total } };
  }

  @RequirePermission('PAY', 'edit')
  @Post('register/recompute')
  async recompute(@ZBody(payPeriodLockSchema) body: { month: string }) {
    return { employees: await this.pay.recomputeTenantMonth(body.month) };
  }

  @RequirePermission('PAY', 'view')
  @Get('employees/:id')
  employee(@Param('id', ParseUUIDPipe) id: string, @Query('month') month: string) {
    return this.pay.employeeMonth(id, monthSchema.parse(month));
  }

  @RequirePermission('PAY', 'create')
  @Post('adjustments')
  addAdjustment(@ZBody(payAdjustmentSchema) body: z.infer<typeof payAdjustmentSchema>) {
    return this.pay.addAdjustment(body);
  }

  @RequirePermission('PAY', 'delete')
  @Post('adjustments/:id/void')
  async voidAdjustment(@Param('id', ParseUUIDPipe) id: string, @ZBody(z.object({ reason: reasonSchema })) body: { reason: string }) {
    await this.pay.voidAdjustment(id, body.reason);
    return { ok: true };
  }

  @RequirePermission('PAY', 'edit')
  @Get('periods/:month/lock-check')
  lockCheck(@Param('month') month: string) {
    return this.pay.lockCheck(monthSchema.parse(month));
  }

  @RequirePermission('PAY', 'edit')
  @Post('periods/lock')
  lock(@ZBody(payPeriodLockSchema) body: { month: string }) {
    return this.pay.lock(body.month);
  }

  @AdminOnly()
  @Post('periods/unlock')
  unlock(@ZBody(payPeriodUnlockSchema) body: { month: string; reason: string }) {
    return this.pay.unlock(body.month, body.reason);
  }
}

@EmployeeApi()
@RequireFeature('EMPLOYEE_EARNINGS_VIEW')
@Controller('v1/mobile/earnings')
export class MobileEarningsController {
  constructor(private readonly pay: PayService) {}

  @Get('current')
  current(@Query('month') month: string) {
    return this.pay.earnings(requireEmployee().employeeId, monthSchema.parse(month), true);
  }

  @Get('history')
  history(@Query('month') month: string) {
    return this.pay.earnings(requireEmployee().employeeId, monthSchema.parse(month), false);
  }
}
