import { Controller, Get, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import {
  leaveApplyOnBehalfSchema,
  leaveApplySchema,
  leaveBalanceAdjustSchema,
  leaveDecisionSchema,
  leaveListQuerySchema,
  leaveTypeSchema,
} from '@attendance/contracts';
import { z } from 'zod';
import { EmployeeApi, RequireFeature, RequirePermission, TenantApi } from '../../core/auth/decorators.js';
import { requireEmployee } from '../../core/context/request-context.js';
import { paged } from '../../core/http/envelope.js';
import { ZBody, ZQuery } from '../../core/http/zod.js';
import { LeaveService } from './leave.service.js';

const yearSchema = z.coerce.number().int().min(2000).max(2100).catch(new Date().getFullYear());

@TenantApi()
@Controller('v1/tenant/leave')
export class LeaveController {
  constructor(private readonly leave: LeaveService) {}

  @Get('types')
  types() {
    return this.leave.types();
  }

  @RequirePermission('LEAVE_SETUP', 'create')
  @Post('types')
  createType(@ZBody(leaveTypeSchema) body: z.infer<typeof leaveTypeSchema>) {
    return this.leave.createType(body);
  }

  @RequirePermission('LEAVE_SETUP', 'edit')
  @Put('types/:id')
  updateType(@Param('id', ParseUUIDPipe) id: string, @ZBody(leaveTypeSchema) body: z.infer<typeof leaveTypeSchema>) {
    return this.leave.updateType(id, body);
  }

  @RequireFeature('LEAVE')
  @RequirePermission('LEAVE', 'view')
  @Get('requests')
  async list(@ZQuery(leaveListQuerySchema) q: z.infer<typeof leaveListQuerySchema>) {
    const { items, total } = await this.leave.list(q);
    return paged(items, { page: q.page, pageSize: q.pageSize, total });
  }

  @RequireFeature('LEAVE')
  @RequirePermission('LEAVE', 'create')
  @Post('requests')
  applyOnBehalf(@ZBody(leaveApplyOnBehalfSchema) body: z.infer<typeof leaveApplyOnBehalfSchema>) {
    return this.leave.applyOnBehalf(body);
  }

  @RequireFeature('LEAVE')
  @RequirePermission('LEAVE', 'edit')
  @Post('requests/:id/approve')
  approve(@Param('id', ParseUUIDPipe) id: string, @ZBody(leaveDecisionSchema) body: z.infer<typeof leaveDecisionSchema>) {
    return this.leave.decide(id, 'APPROVED', body.note);
  }

  @RequireFeature('LEAVE')
  @RequirePermission('LEAVE', 'edit')
  @Post('requests/:id/reject')
  reject(@Param('id', ParseUUIDPipe) id: string, @ZBody(leaveDecisionSchema) body: z.infer<typeof leaveDecisionSchema>) {
    return this.leave.decide(id, 'REJECTED', body.note);
  }

  @RequireFeature('LEAVE')
  @RequirePermission('LEAVE', 'edit')
  @Post('requests/:id/cancel')
  cancel(@Param('id', ParseUUIDPipe) id: string) {
    return this.leave.cancel(id);
  }

  @RequireFeature('LEAVE')
  @RequirePermission('LEAVE', 'view')
  @Get('employees/:id/balances')
  balances(@Param('id', ParseUUIDPipe) id: string, @Query('year') year?: string) {
    return this.leave.balances(id, yearSchema.parse(year));
  }

  @RequireFeature('LEAVE')
  @RequirePermission('LEAVE', 'edit')
  @Post('balances/adjust')
  adjust(@ZBody(leaveBalanceAdjustSchema) body: z.infer<typeof leaveBalanceAdjustSchema>) {
    return this.leave.adjustBalance(body);
  }
}

@EmployeeApi()
@RequireFeature('LEAVE')
@Controller('v1/mobile/leave')
export class MobileLeaveController {
  constructor(private readonly leave: LeaveService) {}

  @Get('types')
  types() {
    return this.leave.types(true);
  }

  @Get('balances')
  balances(@Query('year') year?: string) {
    return this.leave.balances(requireEmployee().employeeId, yearSchema.parse(year));
  }

  @Get('requests')
  mine() {
    return this.leave.myRequests();
  }

  @Post('requests')
  apply(@ZBody(leaveApplySchema) body: z.infer<typeof leaveApplySchema>) {
    return this.leave.apply(body);
  }

  @Post('requests/:id/cancel')
  cancel(@Param('id', ParseUUIDPipe) id: string) {
    return this.leave.cancel(id);
  }
}
