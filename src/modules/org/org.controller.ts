import { Controller, Get, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { branchSchema, departmentSchema, siteSchema } from '@attendance/contracts';
import type { z } from 'zod';
import { RequirePermission, TenantApi } from '../../core/auth/decorators.js';
import { ZBody } from '../../core/http/zod.js';
import { OrgService } from './org.service.js';

@TenantApi()
@Controller('v1/tenant')
export class OrgController {
  constructor(private readonly org: OrgService) {}

  @Get('branches')
  branches() {
    return this.org.branches();
  }

  @RequirePermission('SETTINGS', 'create')
  @Post('branches')
  createBranch(@ZBody(branchSchema) body: z.infer<typeof branchSchema>) {
    return this.org.createBranch(body);
  }

  @RequirePermission('SETTINGS', 'edit')
  @Put('branches/:id')
  updateBranch(@Param('id', ParseUUIDPipe) id: string, @ZBody(branchSchema) body: z.infer<typeof branchSchema>) {
    return this.org.updateBranch(id, body);
  }

  @Get('departments')
  departments() {
    return this.org.departments();
  }

  @RequirePermission('SETTINGS', 'create')
  @Post('departments')
  createDepartment(@ZBody(departmentSchema) body: z.infer<typeof departmentSchema>) {
    return this.org.createDepartment(body);
  }

  @RequirePermission('SETTINGS', 'edit')
  @Put('departments/:id')
  updateDepartment(@Param('id', ParseUUIDPipe) id: string, @ZBody(departmentSchema) body: z.infer<typeof departmentSchema>) {
    return this.org.updateDepartment(id, body);
  }

  @Get('sites')
  sites() {
    return this.org.sites();
  }

  @RequirePermission('SITES', 'create')
  @Post('sites')
  createSite(@ZBody(siteSchema) body: z.infer<typeof siteSchema>) {
    return this.org.createSite(body);
  }

  @RequirePermission('SITES', 'edit')
  @Put('sites/:id')
  updateSite(@Param('id', ParseUUIDPipe) id: string, @ZBody(siteSchema) body: z.infer<typeof siteSchema>) {
    return this.org.updateSite(id, body);
  }
}
