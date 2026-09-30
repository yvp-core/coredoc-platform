import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module.js';
import { DatabaseModule } from '../../database/database.module.js';
import { SourceController } from './source.controller.js';
import { SourceService } from './source.service.js';

@Module({
  imports: [AuthModule, DatabaseModule],
  controllers: [SourceController],
  providers: [SourceService],
  exports: [SourceService],
})
export class SourceModule {}
