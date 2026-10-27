import { Controller, Delete, Get, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import {
  dayOverrideSchema,
  holidayCalendarSchema,
  holidaySchema,
  isoDateSchema,
  policySchema,
  reasonSchema,
  shiftAssignmentSchema,
  shiftSchema,
  weeklyOffPatternSchema,
} from '@attendance/contracts';
import { z } from 'zod';
import { RequirePermission, TenantApi } from '../../core/auth/decorators.js';
import { ZBody, ZQuery } from '../../core/http/zod.js';
import { TimeService } from './time.service.js';

const rangeSchema = z.object({ from: isoDateSchema, to: isoDateSchema });

@TenantApi()
@Controller('v1/tenant')
export class TimeController {
  constructor(private readonly time: TimeService) {}

  @Get('policies')
  policies() {
    return this.time.policies();
  }

  @RequirePermission('SHIFTS', 'create')
  @Post('policies')
  createPolicy(@ZBody(policySchema) body: z.infer<typeof policySchema>) {
    return this.time.createPolicy(body);
  }

  @RequirePermission('SHIFTS', 'edit')
  @Put('policies/:id')
  updatePolicy(@Param('id', ParseUUIDPipe) id: string, @ZBody(policySchema) body: z.infer<typeof policySchema>) {
    return this.time.updatePolicy(id, body);
  }

  @Get('shifts')
  shifts() {
    return this.time.shifts();
  }

  @RequirePermission('SHIFTS', 'create')
  @Post('shifts')
  createShift(@ZBody(shiftSchema) body: z.infer<typeof shiftSchema>) {
    return this.time.createShift(body);
  }

  @RequirePermission('SHIFTS', 'edit')
  @Put('shifts/:id')
  updateShift(@Param('id', ParseUUIDPipe) id: string, @ZBody(shiftSchema) body: z.infer<typeof shiftSchema>) {
    return this.time.updateShift(id, body);
  }

  @RequirePermission('SHIFTS', 'edit')
  @Post('shift-assignments')
  assignShift(@ZBody(shiftAssignmentSchema) body: z.infer<typeof shiftAssignmentSchema>) {
    return this.time.assignShift(body);
  }

  @Get('weekly-offs')
  patterns() {
    return this.time.patterns();
  }

  @RequirePermission('CALENDAR', 'create')
  @Post('weekly-offs')
  createPattern(@ZBody(weeklyOffPatternSchema) body: z.infer<typeof weeklyOffPatternSchema>) {
    return this.time.createPattern(body);
  }

  @RequirePermission('CALENDAR', 'edit')
  @Put('weekly-offs/:id')
  updatePattern(@Param('id', ParseUUIDPipe) id: string, @ZBody(weeklyOffPatternSchema) body: z.infer<typeof weeklyOffPatternSchema>) {
    return this.time.updatePattern(id, body);
  }

  @Get('calendars')
  calendars() {
    return this.time.calendars();
  }

  @RequirePermission('CALENDAR', 'create')
  @Post('calendars')
  createCalendar(@ZBody(holidayCalendarSchema) body: z.infer<typeof holidayCalendarSchema>) {
    return this.time.createCalendar(body);
  }

  @Get('calendars/:id/holidays')
  holidays(@Param('id', ParseUUIDPipe) id: string, @Query('year') year?: string) {
    const parsed = z.coerce.number().int().min(2000).max(2100).catch(new Date().getFullYear()).parse(year);
    return this.time.holidays(id, parsed);
  }

  @RequirePermission('CALENDAR', 'create')
  @Post('calendars/:id/holidays')
  addHoliday(@Param('id', ParseUUIDPipe) id: string, @ZBody(holidaySchema) body: z.infer<typeof holidaySchema>) {
    return this.time.addHoliday(id, body);
  }

  @RequirePermission('CALENDAR', 'delete')
  @Delete('holidays/:id')
  async removeHoliday(@Param('id', ParseUUIDPipe) id: string) {
    await this.time.removeHoliday(id);
    return { ok: true };
  }

  @RequirePermission('CALENDAR', 'view')
  @Get('day-overrides')
  overrides(@ZQuery(rangeSchema) query: z.infer<typeof rangeSchema>) {
    return this.time.overrides(query.from, query.to);
  }

  @RequirePermission('CALENDAR', 'edit')
  @Post('day-overrides')
  grant(@ZBody(dayOverrideSchema) body: z.infer<typeof dayOverrideSchema>) {
    return this.time.grantOverrides(body);
  }

  @RequirePermission('CALENDAR', 'edit')
  @Post('day-overrides/:id/revoke')
  async revoke(@Param('id', ParseUUIDPipe) id: string, @ZBody(z.object({ reason: reasonSchema })) body: { reason: string }) {
    await this.time.revokeOverride(id, body.reason);
    return { ok: true };
  }
}
