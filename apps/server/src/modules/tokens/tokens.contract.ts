/**
 * Request bodies for minting workspace tokens.
 */
import { z } from 'zod';
import { isoDateField, oneOfField, stringField } from '../../common/validators/field.js';

/**
 * Generic token scope.
 *
 * Scopes are curated: the caller picks a purpose and the server maps it to a fixed permission
 * list, so no request can assemble an arbitrary permission array. The legacy `telemetry` value
 * stays recognizable so the controller can return a bounded refusal instead of minting outside
 * the member-only telemetry endpoint. Defaults to `ci`.
 */
export enum TokenScope {
  /** CI/CD publishing and automatic intent credential — CI_TOKEN_PERMISSIONS. */
  Ci = 'ci',
  /** Hosted MCP intent credential — INTENT_AGENT_TOKEN_PERMISSIONS (read + propose only). */
  IntentAgent = 'intent-agent',
  /** Refused here; minted only by the member-only telemetry-token endpoint. */
  Telemetry = 'telemetry',
  /** Cloud agent runner credential — AGENT_RUNNER_TOKEN_PERMISSIONS, the runner API only. */
  AgentRunner = 'agent-runner',
}

export const CreateTokenSchema = z.object({
  name: stringField('name', { notEmpty: true }),
  expiresAt: isoDateField('expiresAt').optional(),
  scope: oneOfField('scope', Object.values(TokenScope)).optional(),
});

export const CreateTelemetryTokenSchema = z.object({
  /** Identifiable name, e.g. "otel:<hostname>". Defaults to "otel" server-side. */
  name: stringField('name', { max: 128 }).optional(),
});

export type CreateTokenInput = z.infer<typeof CreateTokenSchema>;
export type CreateTelemetryTokenInput = z.infer<typeof CreateTelemetryTokenSchema>;
