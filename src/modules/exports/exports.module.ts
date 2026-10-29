import { Controller, Get, Module, Param, ParseUUIDPipe, Post, Res } from '@nestjs/common';
import { exportRequestSchema } from '@attendance/contracts';
import type { Response } from 'express';
import type { z } from 'zod';
import { RequireFeature, RequirePermission, TenantApi } from '../../core/auth/decorators.js';
import { RawResponse } from '../../core/http/envelope.interceptor.js';
import { ZBody } from '../../core/http/zod.js';
import { AttendanceModule } from '../attendance/attendance.module.js';
import { LeaveModule } from '../leave/leave.module.js';
import { PayModule } from '../pay/pay.module.js';
import { ExportsService } from './exports.service.js';
import { ExportGenerators } from './generators.js';

@TenantApi()
@RequireFeature('EXPORTS')
@Controller('v1/tenant/exports')
export class ExportsController {
  constructor(private readonly exports: ExportsService) {}

  @RequirePermission('REPORTS', 'export')
  @Post()
  request(@ZBody(exportRequestSchema) body: z.infer<typeof exportRequestSchema>) {
    return this.exports.request(body);
  }

  @RequirePermission('REPORTS', 'view')
  @Get()
  list() {
    return this.exports.list();
  }

  @RequirePermission('REPORTS', 'export')
  @RawResponse()
  @Get(':id/download')
  async download(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    res.redirect(302, await this.exports.downloadUrl(id));
  }
}

@Module({
  imports: [AttendanceModule, PayModule, LeaveModule],
  controllers: [ExportsController],
  providers: [ExportsService, ExportGenerators],
  exports: [ExportsService],
})
export class ExportsModule {}
