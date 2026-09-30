/** Internal producer/consumer join used by destination-mode cross-repo tracing. */

import type { IGraphReadRepository } from '@coredoc/db';
import { isScopeBound } from '../../scope-resolver.js';
import type { ScopeContext } from '../../types.js';

/**
 * Reserved WORD callers pass to mean "rows with no persisted system", and the
 * label those rows are rendered under. Same reservation as
 * `list_entrypoints(system:)`, so the two tools agree: a repo whose profile
 * literally tags a transport `unknown` is not selectable by name in either.
 */
export const UNKNOWN_MESSAGING_SYSTEM = 'unknown';

/**
 * INTERNAL sentinel for "no persisted system". Kept distinct from the literal
 * string `'unknown'` so a real transport spelled `unknown` never silently joins
 * the legacy bucket; the sentinel is mapped back to UNKNOWN_MESSAGING_SYSTEM at
 * the response boundary by `displayMessagingSystem`.
 */
const SYSTEMLESS_MESSAGING_SYSTEM = '';

/** Normalize a stored system. Missing/blank becomes the systemless sentinel. */
export function normalizeMessagingSystem(system: string | undefined): string {
  return system?.trim().toLowerCase() || SYSTEMLESS_MESSAGING_SYSTEM;
}

/**
 * Normalize a CALLER-supplied `system`. The reserved word selects systemless
 * rows; anything else is matched literally. Returns undefined when unfiltered.
 */
export function normalizeRequestedMessagingSystem(system: string | undefined): string | undefined {
  if (system === undefined) return undefined;
  const normalized = system.trim().toLowerCase();
  if (!normalized) return undefined;
  return normalized === UNKNOWN_MESSAGING_SYSTEM ? SYSTEMLESS_MESSAGING_SYSTEM : normalized;
}

/** Render a normalized system for output. */
export function displayMessagingSystem(system: string): string {
  return system === SYSTEMLESS_MESSAGING_SYSTEM ? UNKNOWN_MESSAGING_SYSTEM : system;
}

export interface MessagingProducerSite {
  system: string;
  destination: string;
  destinationRef?: string;
  caller: string;
  repo: string;
  filePath: string;
  startLine: number;
}

export interface MessagingConsumerSite {
  system: string;
  destination: string;
  destinationRef?: string;
  handler: string;
  entrypointType: string;
  repo: string;
  filePath: string;
  startLine: number;
}

export interface MessagingGraph {
  producers: MessagingProducerSite[];
  consumers: MessagingConsumerSite[];
  /**
   * Repos whose snapshot predates messaging descriptors. Their sites are EXCLUDED
   * from `producers`/`consumers` above — see `collectMessagingGraph`.
   */
  staleRepos: string[];
}

/**
 * First parser version that persists messaging descriptors. A graph pushed before
 * it stores `kafkaTopic`/`topic` instead of the messaging address fields, and
 * nothing reinterprets those on read — so its messaging edges are simply missing
 * until it is re-parsed. Detecting that is the difference between "coredoc told me
 * to re-parse" and "coredoc said this topic has no producers".
 */
const MESSAGING_SCHEMA_VERSION: readonly [number, number] = [1, 1];

/** True when a snapshot predates the messaging descriptor schema. */
export function predatesMessagingSchema(parserVersion: string | undefined): boolean {
  if (!parserVersion) return true;
  // Providers suffix the language (`1.1.0-python`); compare the semver core only.
  const core = parserVersion.split('-', 1)[0] ?? '';
  const [major, minor] = core.split('.').map((part) => Number.parseInt(part, 10));
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return true;
  const [reqMajor, reqMinor] = MESSAGING_SCHEMA_VERSION;
  return (major as number) < reqMajor || ((major as number) === reqMajor && (minor as number) < reqMinor);
}

/** One line naming the repos that need a re-parse, or undefined when all are current. */
export function messagingStalenessWarning(staleRepos: string[]): string | undefined {
  if (staleRepos.length === 0) return undefined;
  return (
    `⚠ ${staleRepos.join(', ')} ${staleRepos.length === 1 ? 'was' : 'were'} parsed before messaging ` +
    `descriptors and ${staleRepos.length === 1 ? 'contributes' : 'contribute'} no producers or consumers here. ` +
    `Run \`coredoc parse\` and \`coredoc push\` for ${staleRepos.length === 1 ? 'it' : 'them'} to see their messaging edges.`
  );
}

/**
 * Destination tracing widens only for a genuinely unbound local invocation.
 * Explicit, host-bound, and cloud-workspace scopes remain hard boundaries.
 */
export function resolveMessagingQueryHashes(argsScope: string | undefined, scope: ScopeContext): string[] {
  if (argsScope) return scope.repoHashes;
  if (isScopeBound(process.env.COREDOC_SCOPE)) return scope.repoHashes;
  if (scope.origin === 'workspace') return scope.repoHashes;
  return [];
}

export async function collectMessagingGraph(
  repository: IGraphReadRepository,
  repoHashes: string[],
): Promise<MessagingGraph> {
  // `getRepositoryNames` carries `parserVersion` precisely so this join does not
  // have to call `getRepoOverview`, whose per-repo COUNT subqueries would run over
  // the WHOLE graph on the unbound path just to read one string per repo.
  const [queueEntrypoints, eventEntrypoints, calls, repoNameRows] = await Promise.all([
    repository.listEntrypoints({ type: 'queue' }, repoHashes),
    repository.listEntrypoints({ type: 'event' }, repoHashes),
    repository.getExternalCallsWithMessaging(repoHashes),
    repository.getRepositoryNames(repoHashes),
  ]);

  const staleRepos = repoNameRows
    .filter((row) => predatesMessagingSchema(row.parserVersion))
    .map((row) => row.name)
    .sort();
  // Exclude sites from a stale snapshot entirely rather than reinterpreting them.
  // A pre-1.1.0 consumer row records no system, so its broker is UNKNOWABLE —
  // surfacing it anyway would let it be attributed to whatever system happened to
  // publish the same destination string. Only positive evidence excludes: a repo
  // with no overview row is left alone rather than assumed stale.
  const staleSet = new Set(staleRepos);

  const repoNames = new Map(repoNameRows.map((row) => [row.hash, row.name]));
  const resolveRepo = (nodeId: string): string => {
    const colon = nodeId.indexOf(':');
    const hash = colon > 0 ? nodeId.slice(0, colon) : '';
    return (hash && repoNames.get(hash)) || 'unknown';
  };
  const producers: MessagingProducerSite[] = [];
  for (const call of calls) {
    const repo = resolveRepo(call.id);
    if (staleSet.has(repo)) continue;
    producers.push({
      system: normalizeMessagingSystem(call.system),
      destination: call.destination,
      destinationRef: call.destinationRef,
      caller: call.callerName,
      repo,
      filePath: call.filePath,
      startLine: call.startLine,
    });
  }

  const consumers: MessagingConsumerSite[] = [];
  for (const entrypoint of [...queueEntrypoints, ...eventEntrypoints]) {
    const repo = resolveRepo(entrypoint.id);
    if (staleSet.has(repo)) continue;
    // Canonical fields only. A current snapshot always persists the messaging
    // address, so the legacy `topic`/`eventName` legs would only ever fire for a
    // stale row — which is excluded above.
    const runtimeDestination = entrypoint.destinationValue ?? entrypoint.destination;
    if (!runtimeDestination) continue;
    consumers.push({
      system: normalizeMessagingSystem(entrypoint.system),
      destination: runtimeDestination,
      destinationRef: entrypoint.destination,
      handler: entrypoint.handlerName || 'unknown',
      entrypointType: entrypoint.type,
      repo,
      filePath: entrypoint.filePath,
      startLine: entrypoint.startLine,
    });
  }

  return { producers, consumers, staleRepos };
}
