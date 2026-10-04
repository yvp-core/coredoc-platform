/**
 * TEMPORARY role-limited intent rollout (`INTENT_ROLES`, see `IntentConfig` in
 * `config/app-config.ts`). A leaf on purpose — no Nest, no Prisma — so the auth
 * and workspace payloads can share the rule without importing a guard. Delete
 * this file with the variable once intent is on for every role.
 */
import type { IntentConfig } from '../../config/app-config.js';

/**
 * Whether intent counts as on for one actor: the workspace flag, narrowed by the
 * TEMPORARY `INTENT_ROLES` rollout list when one is configured.
 *
 * `actorRole` is the principal's role in that workspace as the auth layer
 * resolved it — `WorkspaceRoleGuard` on REST, `McpRewriteMiddleware` on MCP.
 * Both resolve a service token to its CREATOR's current membership, so a token
 * works only while the person who minted it is on the list. An absent or
 * unrecognised role is never on a list, so it fails closed.
 *
 * Every per-actor answer goes through here: the REST and MCP gates (via
 * `isIntentEnabled`) and the workspace payloads the web and desktop gate their
 * intent UI on. The background jobs (handoff cron, merge-triggered releases)
 * have no actor and keep reading the workspace flag alone.
 */
export function intentEnabledForActor(
  workspaceIntentEnabled: boolean,
  actorRole: string | undefined,
  intent: IntentConfig,
): boolean {
  if (!workspaceIntentEnabled) return false;
  if (!intent.rolloutRoles) return true;
  return actorRole !== undefined && (intent.rolloutRoles as readonly string[]).includes(actorRole);
}
