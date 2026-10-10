import { MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { AppConfigModule } from './config/app-config.module.js';
import { configFromEnv } from './config/app-config.js';
import { APP_GUARD } from '@nestjs/core';
import { AuthModule } from './auth/auth.module.js';
import { OAuthModule } from './auth/oauth/oauth.module.js';
import { WebAuthModule } from './auth/web/web-auth.module.js';
import { RequestLoggerMiddleware } from './libs/request-logger.middleware.js';
import { McpModule } from './mcp/mcp.module.js';
import { AgentRunsModule } from './modules/agent-runs/agent-runs.module.js';
import { AgentSessionsModule } from './modules/agent-sessions/agent-sessions.module.js';
import { AnalyticsModule } from './modules/analytics/analytics.module.js';
import { CaptureModule } from './modules/capture/capture.module.js';
import { CliBundleModule } from './modules/cli-bundle/cli-bundle.module.js';
import { CloudAgentRunsApiModule } from './modules/cloud-agent-runs/cloud-agent-runs.module.js';
import { DeliveryApiModule } from './modules/delivery/delivery.module.js';
import { FeedbackModule } from './modules/feedback/feedback.module.js';
import { GraphModule } from './modules/graph/graph.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { IntentModule } from './modules/intent/intent.module.js';
import { JobsApiModule } from './modules/jobs/jobs.module.js';
import { LicenseGuard } from './modules/license/license.guard.js';
import { LicenseApiModule } from './modules/license/license.module.js';
import { MapperApiModule } from './modules/mapper/mapper.module.js';
import { MembersModule } from './modules/members/members.module.js';
import { MetaModule } from './modules/meta/meta.module.js';
import { MetricsApiModule } from './modules/metrics/metrics.module.js';
import { ParsersModule } from './modules/parsers/parsers.module.js';
import { PushApiModule } from './modules/push/push.module.js';
import { ReposModule } from './modules/repos/repos.module.js';
import { SourceModule } from './modules/source/source.module.js';
import { TelemetryModule } from './modules/telemetry/telemetry.module.js';
import { TokensModule } from './modules/tokens/tokens.module.js';
import { WorkspacesModule } from './modules/workspaces/workspaces.module.js';

// Optional HTTP modules are evaluated only when the API graph is loaded.
const misc = configFromEnv().misc;
const optionalModules = [
  ...(misc.enableSourceModule ? [SourceModule] : []),
  ...(misc.enableCliBundle ? [CliBundleModule] : []),
];

@Module({
  imports: [
    AppConfigModule.forRole('api'),
    OAuthModule,
    AuthModule,
    WebAuthModule,
    WorkspacesModule,
    MembersModule,
    ReposModule,
    PushApiModule,
    McpModule,
    ParsersModule,
    TokensModule,
    MapperApiModule,
    MetricsApiModule,
    GraphModule,
    TelemetryModule,
    AgentSessionsModule,
    CaptureModule,
    AgentRunsModule,
    DeliveryApiModule,
    CloudAgentRunsApiModule,
    JobsApiModule,
    HealthModule,
    MetaModule,
    FeedbackModule,
    AnalyticsModule,
    LicenseApiModule,
    IntentModule,
    ...optionalModules,
  ],
  providers: [
    // The server's only global guard. It is inert unless COREDOC_LICENSE_FILE
    // is set AND the license is past its grace window, in which case it
    // refuses mutating /api/v1 requests (see LicenseGuard).
    { provide: APP_GUARD, useClass: LicenseGuard },
  ],
})
export class ApiAppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestLoggerMiddleware).forRoutes('*');
  }
}
