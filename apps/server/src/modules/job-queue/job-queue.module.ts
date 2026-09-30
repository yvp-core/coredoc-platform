import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module.js';
import { PushQueueService } from './push-queue.service.js';

@Module({
  imports: [DatabaseModule],
  providers: [PushQueueService],
  exports: [PushQueueService],
})
export class JobQueueModule {}
