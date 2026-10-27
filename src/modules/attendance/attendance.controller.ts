import { Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  attendanceDailyQuerySchema,
  attendanceRegisterQuerySchema,
  employeeMonthQuerySchema,
  isoDateSchema,
  manualMarkSchema,
  overtimeDecisionSchema,
  revokeMarkSchema,
} from '@attendance/contracts';
import type { z } from 'zod';
import { RequireFeature, RequirePermission, TenantApi } from '../../core/auth/decorators.js';
import { paged } from '../../core/http/envelope.js';
import { ZBody, ZQuery } from '../../core/http/zod.js';
import { AttendanceMarkService } from './attendance-mark.service.js';
import { AttendanceQueryService } from './attendance-query.service.js';

@TenantApi()
@Controller('v1/tenant/attendance')
export class AttendanceController {
  constructor(
    private readonly query: AttendanceQueryService,
    private readonly marks: AttendanceMarkService,
  ) {}

  @RequirePermission('ATTENDANCE', 'view')
  @Get('daily')
  async daily(@ZQuery(attendanceDailyQuerySchema) q: z.infer<typeof attendanceDailyQuerySchema>) {
    const { items, total } = await this.query.daily(q);
    return paged(items, { page: q.page, pageSize: q.pageSize, total });
  }

  @RequirePermission('ATTENDANCE', 'view')
  @Get('register')
  async register(@ZQuery(attendanceRegisterQuerySchema) q: z.infer<typeof attendanceRegisterQuerySchema>) {
    const { dates, items, total } = await this.query.register(q);
    return { dates, items, meta: { page: q.page, pageSize: q.pageSize, total } };
  }

  @RequirePermission('ATTENDANCE', 'view')
  @Get('employees/:id/month')
  month(@Param('id', ParseUUIDPipe) id: string, @ZQuery(employeeMonthQuerySchema) q: z.infer<typeof employeeMonthQuerySchema>) {
    return this.query.employeeMonth(id, q.month);
  }

  @RequirePermission('ATTENDANCE', 'view')
  @Get('employees/:id/days/:date')
  day(@Param('id', ParseUUIDPipe) id: string, @Param('date') date: string) {
    return this.query.dayDetail(id, isoDateSchema.parse(date));
  }

  @RequirePermission('ATTENDANCE', 'view')
  @Get('rejections')
  rejections(@Query('date') date: string) {
    return this.query.rejections(isoDateSchema.parse(date));
  }

  @RequirePermission('ATTENDANCE_MANUAL', 'create')
  @Post('manual-marks')
  mark(@ZBody(manualMarkSchema) body: z.infer<typeof manualMarkSchema>) {
    return this.marks.mark(body);
  }

  @RequirePermission('ATTENDANCE_MANUAL', 'delete')
  @Post('manual-marks/revoke')
  revoke(@ZBody(revokeMarkSchema) body: z.infer<typeof revokeMarkSchema>) {
    return this.marks.revoke(body);
  }

  @RequireFeature('OVERTIME')
  @RequirePermission('ATTENDANCE', 'view')
  @Get('overtime/pending')
  pendingOvertime() {
    return this.marks.pendingOvertime();
  }

  @RequireFeature('OVERTIME')
  @RequirePermission('ATTENDANCE', 'edit')
  @Post('overtime/decisions')
  decide(@ZBody(overtimeDecisionSchema) body: z.infer<typeof overtimeDecisionSchema>) {
    return this.marks.decideOvertime(body);
  }
}
