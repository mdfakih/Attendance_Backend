import { Module } from '@nestjs/common';
import { CompanyController } from './company.controller.js';
import { CompanyService } from './company.service.js';
import { UsersService } from './users.service.js';

@Module({
  controllers: [CompanyController],
  providers: [CompanyService, UsersService],
})
export class CompanyModule {}
