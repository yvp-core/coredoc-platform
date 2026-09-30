import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module.js';
import { CliBundleController } from './cli-bundle.controller.js';
import { CliBundleService } from './cli-bundle.service.js';

@Module({
  imports: [AuthModule],
  controllers: [CliBundleController],
  providers: [CliBundleService],
})
export class CliBundleModule {}
