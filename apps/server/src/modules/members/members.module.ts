import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module.js';
import { DatabaseModule } from '../../database/database.module.js';
import { MembersController } from './members.controller.js';
import { MembersService } from './members.service.js';
import { InvitationRateLimitGuard } from './invitation-rate-limit.guard.js';

@Module({
  imports: [AuthModule, DatabaseModule],
  controllers: [MembersController],
  providers: [MembersService, InvitationRateLimitGuard],
  exports: [MembersService],
})
export class MembersModule {}
