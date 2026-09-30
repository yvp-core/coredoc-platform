/**
 * Cloud ingest body for a desktop agent run. Mirrors `@coredoc/core` `AgentRunSummary`
 * (runId/kind/the 8 economics fields) plus two optional base props the desktop client sends
 * (`appVersion`, `surface`).
 *
 * Every OTHER base prop the shared telemetry client merges onto the event (install_id,
 * session_id, platform, and — critically — any payload `user.*`) is stripped: identity is
 * server-derived from the authenticated principal, never trusted from the body. That is what the
 * global `ValidationPipe({ whitelist: true })` did and what a zod object does by default.
 */
import { z } from 'zod';
import { intField, numberField, oneOfField, stringField } from '../../common/validators/field.js';

export const AGENT_RUN_OUTCOMES = ['success', 'cancelled', 'error'] as const;

export const CreateAgentRunSchema = z.object({
  runId: stringField('runId'),
  // `kind` is currently only 'author-profile' but the run taxonomy may grow, so it stays a free
  // string rather than an enum — bounded (not enum-locked) at this trust boundary to keep the
  // ingested value length-sane.
  kind: stringField('kind', { max: 64 }),
  tokensIn: intField('tokensIn', { min: 0 }),
  tokensOut: intField('tokensOut', { min: 0 }),
  costUsd: numberField('costUsd', { min: 0 }),
  turns: intField('turns', { min: 0 }),
  toolCalls: intField('toolCalls', { min: 0 }),
  interventions: intField('interventions', { min: 0 }),
  // Closed set — the exact terminal outcomes `emitAgentRun` reports. Enum-locked at ingest so a
  // client can't stamp arbitrary outcome strings onto the cloud spine.
  outcome: oneOfField('outcome', AGENT_RUN_OUTCOMES),
  durationMs: intField('durationMs', { min: 0 }),
  appVersion: stringField('appVersion').optional(),
  surface: stringField('surface').optional(),
});

export type CreateAgentRunInput = z.infer<typeof CreateAgentRunSchema>;
