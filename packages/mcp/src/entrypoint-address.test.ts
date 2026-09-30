/**
 * Tests for entrypoint addressing — "which token names this entrypoint?".
 *
 * The label is what a reader sees instead of the node id
 * (`<repoHash>:entrypoint:queue:<hash>`), and the token list is what an
 * agent-typed string is resolved against. Both are per-type: a queue entrypoint
 * has no path, an HTTP one has no schedule, and a wrong precedence silently
 * renders (or fails to find) the wrong entrypoint.
 */

import { describe, it, expect } from 'vitest';
import { entrypointAddressTokens as dbEntrypointAddressTokens } from '@coredoc/db';
import {
  entrypointAddressLabel,
  entrypointAddressTokens,
  displayEntrypointAddress,
  type EntrypointAddressable,
} from './entrypoint-address.js';

describe('entrypointAddressLabel', () => {
  it.each<[string, EntrypointAddressable, string | undefined]>([
    [
      'http prefers the mounted full path over the local one',
      { type: 'http', fullPath: '/v3/users/:id', path: '/:id' },
      '/v3/users/:id',
    ],
    ['http falls back to the local path', { type: 'http', path: '/health' }, '/health'],
    ['graphql names the field', { type: 'graphql', fieldName: 'createUser', path: '/graphql' }, 'createUser'],
    [
      'queue prefers the source-level topic token over the resolved one',
      { type: 'queue', topic: 'TOPIC_CONST', topicValue: 'orders.v1' },
      'TOPIC_CONST',
    ],
    [
      'queue prefers the resolved destination value',
      { type: 'queue', destination: 'QUEUE_CONST', destinationValue: 'billing-jobs' },
      'billing-jobs',
    ],
    [
      'queue falls back to the topic when it has no destination',
      { type: 'queue', topicValue: 'orders.v1' },
      'orders.v1',
    ],
    [
      'event prefers the destination over the event name',
      { type: 'event', destination: 'EVT', eventName: 'user.created' },
      'EVT',
    ],
    ['event falls back to the event name', { type: 'event', eventName: 'user.created' }, 'user.created'],
    ['cron names the schedule', { type: 'cron', schedule: '0 3 * * *' }, '0 3 * * *'],
    ['cli names the command', { type: 'cli', command: 'sync --all' }, 'sync --all'],
    ['mobile names the component class', { type: 'mobile', className: 'MainActivity' }, 'MainActivity'],
    ['websocket names the event', { type: 'websocket', eventName: 'message' }, 'message'],
    [
      'an unknown type falls back through every address field',
      { type: 'grpc', fullPath: '/pkg.Svc/Method' },
      '/pkg.Svc/Method',
    ],
    ['an unknown type falls back to the topic value', { type: 'legacy-unknown', topicValue: 'orders.v1' }, 'orders.v1'],
    [
      'an unknown type prefers a resolved destination',
      { type: 'grpc', destinationValue: 'svc.method', fullPath: '/pkg.Svc/Method' },
      'svc.method',
    ],
  ])('%s', (_label, ep, expected) => {
    expect(entrypointAddressLabel(ep)).toBe(expected);
  });

  // Undefined — never the node id, and never an empty string that would render
  // as a blank title. Callers fall back to the handler name or file location.
  it('returns undefined when the entrypoint carries no address at all', () => {
    expect(entrypointAddressLabel({ type: 'queue' })).toBeUndefined();
    expect(entrypointAddressLabel({ type: 'http' })).toBeUndefined();
  });
});

describe('displayEntrypointAddress', () => {
  // The local `UNRESOLVED_SENTINEL_PREFIX` in entrypoint-address.ts must stay
  // byte-identical to `UNRESOLVED_PREFIX` in
  // packages/profile-parser/src/unresolved-sentinel.ts (the source of truth,
  // not imported here — see this file's module header). Pin the literal so a
  // future rename of the profile-parser constant fails this test loudly
  // instead of silently un-marking sentinels as literal values.
  const PROFILE_PARSER_UNRESOLVED_PREFIX = 'unresolved:';

  it('renders a sentinel value as statically unresolvable, not as a literal topic', () => {
    const ep: EntrypointAddressable = {
      type: 'queue',
      topicValue: `${PROFILE_PARSER_UNRESOLVED_PREFIX}getTopicInNamespace('x')`,
    };
    expect(displayEntrypointAddress(ep)).toBe("<statically unresolvable: getTopicInNamespace('x')>");
  });

  it('passes a real address through unchanged', () => {
    expect(displayEntrypointAddress({ type: 'queue', topicValue: 'orders.v1' })).toBe('orders.v1');
  });

  it('returns undefined when the entrypoint carries no address at all', () => {
    expect(displayEntrypointAddress({ type: 'cli' })).toBeUndefined();
  });
});

describe('entrypointAddressTokens', () => {
  // `explain` addresses an entrypoint by `tokens[0]`, so the label must lead.
  it('leads with the label, then every other non-empty address field', () => {
    const tokens = entrypointAddressTokens({
      type: 'queue',
      destination: 'QUEUE_CONST',
      destinationValue: 'billing-jobs',
      topic: 'billing',
    });
    expect(tokens[0]).toBe('billing-jobs');
    expect(tokens).toEqual(['billing-jobs', 'QUEUE_CONST', 'billing']);
  });

  it('dedupes: the label repeats a field it was derived from', () => {
    const tokens = entrypointAddressTokens({ type: 'cron', schedule: '0 3 * * *' });
    expect(tokens).toEqual(['0 3 * * *']);
  });

  it('dedupes repeated values across different fields', () => {
    const tokens = entrypointAddressTokens({
      type: 'event',
      destination: 'user.created',
      eventName: 'user.created',
      topic: 'user.created',
    });
    expect(tokens).toEqual(['user.created']);
  });

  it('drops empty and whitespace-only fields', () => {
    expect(entrypointAddressTokens({ type: 'http', fullPath: '/a', path: '   ', topic: '' })).toEqual(['/a']);
  });

  it('returns nothing for an entrypoint with no address', () => {
    expect(entrypointAddressTokens({ type: 'cli' })).toEqual([]);
  });
});

// The field list is written twice — here and in `@coredoc/db`'s `route-path.ts`
// (see this module's header for why it cannot yet be collapsed). The two orders
// differ deliberately (the MCP one is label-first because `explain` reads
// `tokens[0]`), but the SET must stay identical: a field added to one and not
// the other makes an entrypoint filterable but unnameable, or the reverse.
describe('parity with the @coredoc/db token twin', () => {
  const fixtures: EntrypointAddressable[] = [
    { type: 'http', fullPath: '/v3/users/:id', path: '/:id' },
    { type: 'graphql', fieldName: 'createUser' },
    { type: 'queue', topic: 'TOPIC_CONST', topicValue: 'orders.v1' },
    { type: 'queue', destination: 'QUEUE_CONST', destinationValue: 'billing-jobs' },
    { type: 'event', destination: 'EVT', eventName: 'user.created' },
    { type: 'cron', schedule: '0 3 * * *' },
    { type: 'cli', command: 'sync --all' },
    { type: 'mobile', className: 'MainActivity' },
    { type: 'websocket', eventName: 'message' },
    {
      type: 'http',
      fullPath: '/a',
      path: '/b',
      fieldName: 'f',
      destination: 'd',
      destinationValue: 'dv',
      topic: 't',
      topicValue: 'tv',
      eventName: 'e',
      command: 'c',
      schedule: 's',
      className: 'cn',
    },
  ];

  it.each(fixtures)('covers the same address fields for $type', (ep) => {
    expect(new Set(entrypointAddressTokens(ep))).toEqual(new Set(dbEntrypointAddressTokens(ep)));
  });
});
