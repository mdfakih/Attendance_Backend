import { Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  attendanceDailyQuerySchema,
  attendanceRegisterQuerySchema,
  employeeMonthQuerySchema,
  isoDateSchema,
  manualMarkSchema,
  regularizationDecisionSchema,
  regularizationListQuerySchema,
  revokeMarkSchema,
} from '@attendance/contracts';
import type { z } from 'zod';
import { RequireFeature, RequirePermission, TenantApi } from '../../core/auth/decorators.js';
import { paged } from '../../core/http/envelope.js';
import { ZBody, ZQuery } from '../../core/http/zod.js';
import { AttendanceMarkService } from './attendance-mark.service.js';
import { AttendanceQueryService } from './attendance-query.service.js';
import { RegularizationService } from './regularization.service.js';

@TenantApi()
@Controller('v1/tenant/attendance')
export class AttendanceController {
  constructor(
    private readonly query: AttendanceQueryService,
    private readonly marks: AttendanceMarkService,
    private readonly regularizations: RegularizationService,
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

  /** Employees' requests to count time worked outside working hours. */
  @RequireFeature('EXTRA_TIME')
  @RequirePermission('ATTENDANCE', 'view')
  @Get('regularizations')
  async regularizationList(@ZQuery(regularizationListQuerySchema) q: z.infer<typeof regularizationListQuerySchema>) {
    const { items, total } = await this.regularizations.list(q);
    return paged(items, { page: q.page, pageSize: q.pageSize, total });
  }

  @RequireFeature('EXTRA_TIME')
  @RequirePermission('ATTENDANCE', 'edit')
  @Post('regularizations/:id/decision')
  decideRegularization(@Param('id', ParseUUIDPipe) id: string, @ZBody(regularizationDecisionSchema) body: z.infer<typeof regularizationDecisionSchema>) {
    return this.regularizations.decide(id, body);
  }
}
