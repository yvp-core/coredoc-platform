import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module.js';
import { DatabaseModule } from '../../database/database.module.js';
import { PushCoreModule } from '../push/push.module.js';
import { ReposController } from './repos.controller.js';
import { ReposService } from './repos.service.js';

@Module({
  imports: [AuthModule, DatabaseModule, PushCoreModule],
  controllers: [ReposController],
  providers: [ReposService],
  exports: [ReposService],
})
export class ReposModule {}
