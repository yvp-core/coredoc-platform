import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module.js';
import { DatabaseModule } from '../../database/database.module.js';
import { AccessAreasController } from './access-areas.controller.js';
import { AccessAreasService } from './access-areas.service.js';

@Module({
  imports: [AuthModule, DatabaseModule],
  controllers: [AccessAreasController],
  providers: [AccessAreasService],
})
export class AccessAreasModule {}
