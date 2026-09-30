import { IntentReleaseTrigger } from '../../generated/prisma/client.js';

/** One effective mode for the CI guard and the connector, including legacy repos. */
export function resolveIntentReleaseTrigger(
  repo: IntentReleaseTrigger | null | undefined,
  workspace: IntentReleaseTrigger | null | undefined,
): IntentReleaseTrigger {
  return repo ?? workspace ?? IntentReleaseTrigger.manual;
}
