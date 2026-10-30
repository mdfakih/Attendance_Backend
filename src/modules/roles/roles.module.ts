import { Module } from '@nestjs/common';
import { RolesService } from './roles.service.js';

/** Client roles and permissions, shared by the platform console (edit) and the client dashboard (read). */
@Module({
  providers: [RolesService],
  exports: [RolesService],
})
export class RolesModule {}
