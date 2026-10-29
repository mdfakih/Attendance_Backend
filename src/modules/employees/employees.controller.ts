import { Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  bindingDecisionSchema,
  bulkCodesSchema,
  CODE_PURPOSES,
  employeeCreateSchema,
  employeeDeactivateSchema,
  employeeListQuerySchema,
  employeeUpdateSchema,
  releaseDeviceSchema,
  salaryInputSchema,
} from '@attendance/contracts';
import type { Response } from 'express';
import { z } from 'zod';
import { RequireFeature, RequirePermission, TenantApi } from '../../core/auth/decorators.js';
import { AppError } from '../../core/http/app-error.js';
import { paged } from '../../core/http/envelope.js';
import { RawResponse } from '../../core/http/envelope.interceptor.js';
import { ZBody, ZQuery } from '../../core/http/zod.js';
import { buildXlsx, XLSX_MIME } from '../../common/xlsx.js';
import { DevicesService } from './devices.service.js';
import { EmployeesService } from './employees.service.js';
import { ImportService } from './import.service.js';
import { SalaryService } from './salary.service.js';

const purposeSchema = z.object({ purpose: z.enum(CODE_PURPOSES).default('ACTIVATION') });
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

interface UploadedXlsx {
  readonly originalname: string;
  readonly buffer: Buffer;
  readonly size: number;
}

function sendXlsx(res: Response, fileName: string, buffer: Buffer): void {
  res.setHeader('Content-Type', XLSX_MIME);
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(buffer);
}

async function codesSheet(rows: Awaited<ReturnType<DevicesService['bulkCodes']>>): Promise<Buffer> {
  return buildXlsx([
    {
      name: 'Activation codes',
      columns: [
        { header: 'Name', key: 'fullName', width: 28 },
        { header: 'Employee code', key: 'employeeCode', width: 16 },
        { header: 'Mobile number', key: 'phone', width: 16 },
        { header: 'Activation code', key: 'code', width: 16 },
        { header: 'Valid until', key: 'expiresAt', width: 22 },
        { header: 'Note', key: 'note', width: 26 },
      ],
      rows: rows.map((r) => ({ ...r, expiresAt: r.expiresAt ? r.expiresAt.toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '' })),
    },
  ]);
}

@TenantApi()
@Controller('v1/tenant')
export class EmployeesController {
  constructor(
    private readonly employees: EmployeesService,
    private readonly devices: DevicesService,
    private readonly imports: ImportService,
    private readonly salary: SalaryService,
  ) {}

  @RequirePermission('EMPLOYEES', 'view')
  @Get('employees')
  async list(@ZQuery(employeeListQuerySchema) query: z.infer<typeof employeeListQuerySchema>) {
    const { items, total } = await this.employees.list(query);
    return paged(items, { page: query.page, pageSize: query.pageSize, total });
  }

  @RequirePermission('EMPLOYEES', 'create')
  @Post('employees')
  create(@ZBody(employeeCreateSchema) body: z.infer<typeof employeeCreateSchema>) {
    return this.employees.create(body);
  }

  @RequirePermission('EMPLOYEES', 'view')
  @Get('employees/:id')
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.employees.detail(id);
  }

  @RequirePermission('EMPLOYEES', 'edit')
  @Patch('employees/:id')
  update(@Param('id', ParseUUIDPipe) id: string, @ZBody(employeeUpdateSchema) body: z.infer<typeof employeeUpdateSchema>) {
    return this.employees.update(id, body);
  }

  @RequirePermission('EMPLOYEES', 'delete')
  @Post('employees/:id/deactivate')
  deactivate(@Param('id', ParseUUIDPipe) id: string, @ZBody(employeeDeactivateSchema) body: z.infer<typeof employeeDeactivateSchema>) {
    return this.employees.deactivate(id, body);
  }

  @RequirePermission('EMPLOYEES', 'edit')
  @Post('employees/:id/reactivate')
  reactivate(@Param('id', ParseUUIDPipe) id: string) {
    return this.employees.reactivate(id);
  }

  @RequirePermission('EMPLOYEE_SALARY', 'edit')
  @Post('employees/:id/salary')
  addSalary(@Param('id', ParseUUIDPipe) id: string, @ZBody(salaryInputSchema) body: z.infer<typeof salaryInputSchema>) {
    return this.salary.addRevision(id, body);
  }

  @RequirePermission('DEVICES', 'view')
  @Get('employees/:id/activation-code')
  async revealCode(@Param('id', ParseUUIDPipe) id: string, @ZQuery(purposeSchema) query: z.infer<typeof purposeSchema>) {
    return { code: await this.devices.revealCode(id, query.purpose) };
  }

  @RequirePermission('DEVICES', 'create')
  @Post('employees/:id/activation-code')
  regenerate(@Param('id', ParseUUIDPipe) id: string, @ZBody(purposeSchema) body: z.infer<typeof purposeSchema>) {
    return this.devices.regenerateCode(id, body.purpose);
  }

  @RequirePermission('DEVICES', 'create')
  @Post('employees/:id/activation-code/email')
  async emailCode(@Param('id', ParseUUIDPipe) id: string) {
    await this.devices.emailCode(id);
    return { ok: true };
  }

  @RequirePermission('DEVICES', 'edit')
  @Post('employees/:id/release-device')
  release(@Param('id', ParseUUIDPipe) id: string, @ZBody(releaseDeviceSchema) body: z.infer<typeof releaseDeviceSchema>) {
    return this.devices.release(id, body.reason);
  }

  @RequirePermission('DEVICES', 'export')
  @RawResponse()
  @Post('activation-codes/export')
  async exportCodes(@ZBody(bulkCodesSchema) body: z.infer<typeof bulkCodesSchema>, @Res() res: Response) {
    sendXlsx(res, 'activation-codes.xlsx', await codesSheet(await this.devices.bulkCodes(body.employeeIds)));
  }

  @RequirePermission('DEVICES', 'view')
  @Get('devices')
  bindings(@Query('status') status?: string) {
    return this.devices.bindings(status === 'PENDING' || status === 'ACTIVE' ? status : undefined);
  }

  @RequirePermission('DEVICES', 'edit')
  @Post('devices/:id/approve')
  approve(@Param('id', ParseUUIDPipe) id: string) {
    return this.devices.approve(id);
  }

  @RequirePermission('DEVICES', 'edit')
  @Post('devices/:id/reject')
  reject(@Param('id', ParseUUIDPipe) id: string, @ZBody(bindingDecisionSchema) body: z.infer<typeof bindingDecisionSchema>) {
    return this.devices.reject(id, body.note);
  }

  @RequirePermission('DEVICES', 'view')
  @Get('devices/:id/activation-selfie')
  selfie(@Param('id', ParseUUIDPipe) id: string) {
    return this.devices.activationSelfieUrl(id);
  }

  @RequireFeature('BULK_IMPORT')
  @RequirePermission('EMPLOYEES', 'create')
  @RawResponse()
  @Get('employee-imports/template')
  async template(@Res() res: Response) {
    sendXlsx(res, 'employee-upload-template.xlsx', await this.imports.template());
  }

  @RequireFeature('BULK_IMPORT')
  @RequirePermission('EMPLOYEES', 'create')
  @Post('employee-imports')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } }))
  upload(@UploadedFile() file: UploadedXlsx | undefined) {
    if (!file?.buffer?.length) {
      throw new AppError('IMPORT_INVALID', 'Attach the filled-in Excel template.');
    }
    if (!file.originalname.toLowerCase().endsWith('.xlsx')) {
      throw new AppError('IMPORT_INVALID', 'Upload an .xlsx file made from the template.');
    }
    return this.imports.upload(file.originalname, file.buffer);
  }

  @RequireFeature('BULK_IMPORT')
  @RequirePermission('EMPLOYEES', 'create')
  @Get('employee-imports/:id')
  preview(@Param('id', ParseUUIDPipe) id: string) {
    return this.imports.preview(id);
  }

  @RequireFeature('BULK_IMPORT')
  @RequirePermission('EMPLOYEES', 'create')
  @Post('employee-imports/:id/commit')
  commit(@Param('id', ParseUUIDPipe) id: string) {
    return this.imports.commit(id);
  }

  @RequireFeature('BULK_IMPORT')
  @RequirePermission('EMPLOYEES', 'create')
  @Post('employee-imports/:id/cancel')
  async cancel(@Param('id', ParseUUIDPipe) id: string) {
    await this.imports.cancel(id);
    return { ok: true };
  }

  @RequirePermission('DEVICES', 'export')
  @RawResponse()
  @Get('employee-imports/:id/codes')
  async importCodes(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const ids = await this.imports.committedEmployeeIds(id);
    sendXlsx(res, 'activation-codes.xlsx', await codesSheet(ids.length ? await this.devices.bulkCodes(ids) : []));
  }
}
