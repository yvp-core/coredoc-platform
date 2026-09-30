/**
 * Messaging-system spelling lint.
 *
 * Cross-repo resolution keys queue/event entrypoints on `(system, destination)`
 * and normalizes case and whitespace ONLY — `'gcp-pubsub'` and `'google-pubsub'`
 * are different transports as far as the linker is concerned. A profile that
 * spells the same bus two ways produces a graph where those edges resolve to
 * nothing, with no error anywhere: the parse succeeds, the counts look right,
 * and only the resolution rate moves.
 *
 * This is not hypothetical — nine pilot profiles declared their background-queue
 * consumers as `google-pubsub` while publishing through a `gcp-pubsub` matcher.
 *
 * DETECTION. Set intersection is the obvious check and it does not work: those
 * nine profiles declare a SECOND consumer rule that does match the publisher, so
 * the two sides intersect and a disjointness test stays silent. Nor can orphan
 * analysis help — a consumer with no local publisher is the normal shape when
 * the publisher lives in a sibling repo.
 *
 * What actually separates drift from intent is SIMILARITY: two spellings in one
 * profile that share a word (`gcp-pubsub` / `google-pubsub` → `pubsub`) are
 * almost certainly the same bus written twice, while genuinely different buses
 * (`kafka` / `sqs`) share nothing. So the lint reports confusable PAIRS, and
 * says nothing about how many rules use each.
 */

/** Minimal shape read from a profile; keeps this module free of the full schema. */
interface QueueSystemSource {
  kind?: string;
  system?: string;
}

interface MessagingProfileLike {
  entrypoints?: unknown;
  externalCalls?: unknown;
  [key: string]: unknown;
}

export interface MessagingSystemWarning {
  /** The two confusable spellings, sorted. */
  pair: [string, string];
  /** The word they have in common. */
  sharedToken: string;
  message: string;
}

function normalize(system: string | undefined): string | undefined {
  const trimmed = system?.trim().toLowerCase();
  return trimmed ? trimmed : undefined;
}

/** Split a system spelling into comparable words: `gcp-pubsub` → ['gcp','pubsub']. */
function tokens(system: string): string[] {
  return system.split(/[^a-z0-9]+/).filter(Boolean);
}

function queueRules(value: unknown): readonly QueueSystemSource[] {
  return Array.isArray(value) ? (value as readonly QueueSystemSource[]) : [];
}

/** Every queue system a profile declares, from BOTH the consumer and producer side. */
function declaredSystems(profile: MessagingProfileLike): string[] {
  const systems = new Set<string>();
  for (const rule of [...queueRules(profile.entrypoints), ...queueRules(profile.externalCalls)]) {
    if (rule?.kind !== 'queue') continue;
    const system = normalize(rule.system);
    if (system) systems.add(system);
  }
  return [...systems].sort();
}

/**
 * Reports every pair of distinct messaging-system spellings in one profile that
 * share a word — the shape of an accidental alias rather than a second bus.
 * Empty when the profile declares fewer than two systems, or when all of them
 * are unambiguously different transports.
 */
export function lintMessagingSystems(profile: MessagingProfileLike): MessagingSystemWarning[] {
  const systems = declaredSystems(profile);
  const warnings: MessagingSystemWarning[] = [];
  for (let i = 0; i < systems.length; i++) {
    for (let j = i + 1; j < systems.length; j++) {
      const a = systems[i]!;
      const b = systems[j]!;
      const shared = tokens(a).find((token) => tokens(b).includes(token));
      if (!shared) continue;
      warnings.push({
        pair: [a, b],
        sharedToken: shared,
        message:
          `messaging systems \`${a}\` and \`${b}\` look like two spellings of one transport ` +
          `(both contain \`${shared}\`). Cross-repo resolution matches the system spelling exactly ` +
          `(case/whitespace normalized only), so publishers and consumers split across these two ` +
          `will not join. Use one spelling per transport, or ignore this if they really are ` +
          `different buses.`,
      });
    }
  }
  return warnings;
}
