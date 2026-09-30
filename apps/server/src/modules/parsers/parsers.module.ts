import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module.js';
import { DatabaseModule } from '../../database/database.module.js';
import { ParsersController } from './parsers.controller.js';
import { ParsersService } from './parsers.service.js';

@Module({
  imports: [AuthModule, DatabaseModule],
  controllers: [ParsersController],
  providers: [ParsersService],
  exports: [ParsersService],
})
export class ParsersModule {}
