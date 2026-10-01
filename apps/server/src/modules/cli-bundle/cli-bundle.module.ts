import { Module } from '@nestjs/common';
import { CliBundleController } from './cli-bundle.controller.js';
import { CliBundleService } from './cli-bundle.service.js';

@Module({
  controllers: [CliBundleController],
  providers: [CliBundleService],
})
export class CliBundleModule {}
