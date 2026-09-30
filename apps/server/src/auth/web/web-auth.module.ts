/**
 * Web session auth: server-driven PKCE login against our self-hosted OAuth AS,
 * loopback token exchange, and the coredoc_session/coredoc_refresh cookies
 * AuthGuard reads. See web-auth.service.ts for the full flow.
 *
 * PrismaService/ControlPlaneService come from the @Global() DatabaseModule;
 * AuthModule is imported for AuthGuard (used by GET /api/v1/me).
 */

import { Module, type OnModuleInit } from '@nestjs/common';
import { AuthModule } from '../auth.module.js';
import { WebAuthController } from './web-auth.controller.js';
import { WebAuthService } from './web-auth.service.js';

@Module({
  imports: [AuthModule],
  controllers: [WebAuthController],
  providers: [WebAuthService],
})
export class WebAuthModule implements OnModuleInit {
  constructor(private readonly webAuth: WebAuthService) {}

  async onModuleInit(): Promise<void> {
    await this.webAuth.seedClient();
  }
}
