import { Inject, Injectable, Logger, Optional, OnModuleDestroy } from '@nestjs/common';
import { TELEMETRY_CONFIG, type TelemetryConfig, telemetryConfigFromEnv } from '../../config/app-config.js';
import { PostHog } from 'posthog-node';

@Injectable()
export class TelemetryService implements OnModuleDestroy {
  private readonly logger = new Logger(TelemetryService.name);
  private client: PostHog | null = null;

  constructor(
    @Optional() @Inject(TELEMETRY_CONFIG) private readonly config: TelemetryConfig = telemetryConfigFromEnv(),
  ) {}

  private getClient(): PostHog | null {
    const { posthogKey: apiKey, posthogHost: host } = this.config;
    if (!apiKey || !host) return null;
    if (this.client) return this.client;

    try {
      this.client = new PostHog(apiKey, { host });
      return this.client;
    } catch (err) {
      this.logger.warn(`Failed to initialize PostHog: ${err}`);
      return null;
    }
  }

  trackEvent(workspaceId: string, event: string, properties: Record<string, unknown> = {}, userId?: string): void {
    try {
      const client = this.getClient();
      if (!client) return;

      client.capture({
        distinctId: userId || `workspace:${workspaceId}`,
        event,
        properties: {
          ...properties,
          workspaceId,
          $lib: 'coredoc-server',
        },
        groups: { workspace: workspaceId },
      });
    } catch (err) {
      this.logger.error(`Failed to track event: ${err}`);
    }
  }

  /**
   * Forward a server-side exception to PostHog. Best-effort: never throws.
   * `distinctId` falls back to a synthetic "server" id when no user/workspace
   * context is available (e.g. unauthenticated requests).
   */
  captureException(
    error: unknown,
    context: { workspaceId?: string; userId?: string; properties?: Record<string, unknown> } = {},
  ): void {
    try {
      const client = this.getClient();
      if (!client) return;

      const { workspaceId, userId, properties } = context;
      const distinctId = userId || (workspaceId ? `workspace:${workspaceId}` : 'server');
      client.captureException(error, distinctId, {
        ...properties,
        ...(workspaceId ? { workspaceId } : {}),
        $lib: 'coredoc-server',
      });
    } catch (err) {
      this.logger.error(`Failed to capture exception: ${err}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    try {
      if (this.client) {
        await this.client.shutdown();
        this.client = null;
      }
    } catch {
      // Ignore shutdown errors
    }
  }
}
