/**
 * Entrypoint addressing for the tool layer — "which token names this
 * entrypoint?".
 *
 * An entrypoint node stores its own node id in the `name` column, so anything
 * that treats `name` as human text leaks `<repoHash>:entrypoint:queue:<hash>`
 * into a title, and anything that addresses entrypoints by path can only ever
 * find HTTP ones. Both problems need the same answer: the type-specific address
 * (HTTP path, GraphQL field, queue/event destination, Kafka topic, cron
 * schedule, CLI command).
 *
 * The raw address field list lives once, in `@coredoc/db/route-path` (a
 * mock-free subpath: tool-handler tests replace the `@coredoc/db` root wholesale).
 */

import { type EntrypointAddress, entrypointAddressTokens as addressFieldTokens } from '@coredoc/db/route-path';

/**
 * Structural subset shared by the MCP `EntrypointInfo` and the db-layer one
 * (whose `handlerName` is optional): only the address fields matter here.
 */
export interface EntrypointAddressable extends EntrypointAddress {
  type: string;
}

/**
 * Prefix `@coredoc/profile-parser` marks an entrypoint dimension value with
 * when the detector matched but the value was not a static string (queue
 * topic, route path, cli command) — see
 * `packages/profile-parser/src/unresolved-sentinel.ts` `UNRESOLVED_PREFIX`.
 * Duplicated locally (not imported) because `@coredoc/mcp` depending on the
 * whole profile-parser engine for one string constant is disproportionate;
 * `entrypoint-address.test.ts` pins this literal against the source of truth
 * so the two cannot drift apart silently.
 */
const UNRESOLVED_SENTINEL_PREFIX = 'unresolved:';

/**
 * Render an entrypoint address for display, naming a statically-unresolvable
 * sentinel value instead of showing it as if it were a literal topic/path/
 * command — the whole point of persisting the sentinel is that a reader must
 * never mistake it for a real value (spec: dynamic-boundaries UC-3).
 */
export function displayEntrypointAddress(ep: EntrypointAddressable): string | undefined {
  const address = entrypointAddressLabel(ep);
  if (address === undefined || !address.startsWith(UNRESOLVED_SENTINEL_PREFIX)) return address;
  return `<statically unresolvable: ${address.slice(UNRESOLVED_SENTINEL_PREFIX.length)}>`;
}

/**
 * The human address of an entrypoint — the token an agent would recognise and
 * could search for. Undefined when the entrypoint carries none of them (callers
 * fall back to the handler name or the file location). NEVER the node id.
 */
export function entrypointAddressLabel(ep: EntrypointAddressable): string | undefined {
  switch (ep.type) {
    case 'http':
      return ep.fullPath || ep.path;
    case 'graphql':
      return ep.fieldName;
    case 'queue':
      return ep.destinationValue || ep.destination || ep.topic || ep.topicValue;
    case 'event':
      return ep.destinationValue || ep.destination || ep.eventName || ep.topic || ep.topicValue;
    case 'cron':
      return ep.schedule;
    case 'cli':
      return ep.command;
    case 'mobile':
      return ep.className;
    case 'websocket':
      return ep.eventName;
    default:
      // Unknown/newer types still carry one of the address fields — keep the
      // read side type-agnostic rather than failing closed.
      return (
        ep.destinationValue || ep.destination || ep.topic || ep.topicValue || ep.schedule || ep.fullPath || ep.path
      );
  }
}

/**
 * Every non-empty address token of an entrypoint (label first). Used to resolve
 * an agent-typed token — a topic constant, its bare last segment, or the
 * literal destination string — back to the entrypoint.
 */
export function entrypointAddressTokens(ep: EntrypointAddressable): string[] {
  const tokens = [entrypointAddressLabel(ep), ...addressFieldTokens(ep)].filter(
    (token): token is string => typeof token === 'string' && token.trim().length > 0,
  );
  return [...new Set(tokens)];
}
