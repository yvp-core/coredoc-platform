/**
 * Acceptance for call-shape queue entrypoints and the emit-with-unresolved
 * contract (audit finding G7).
 *
 * A `kind: 'queue'` rule detected by call-shape with no handler-table used to
 * emit NOTHING at all, and every non-literal topic was dropped without a trace.
 * The engine now (a) extracts call-shape queue registrations directly, (b) folds
 * a module-level string const (same-file and one import hop) into `topicValue`,
 * and (c) when the topic is not statically foldable emits the entrypoint anyway
 * with an `unresolved:` sentinel topic plus one warning per rule per file.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ParsedRepo, QueueEntrypointDetails } from '@coredoc/core/types';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExtractionProfile } from '../types.js';
import { runProfile } from './run.js';

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const QUEUE_RULE: NonNullable<ExtractionProfile['entrypoints']> = [
  {
    kind: 'queue',
    detect: { via: 'call-shape', callee: 'createKafkaConsumer' },
    system: 'kafka',
    topic: { arg: 0, as: 'object-property', key: 'topic' },
  },
];

async function run(files: Record<string, string>): Promise<ParsedRepo> {
  dir = mkdtempSync(join(tmpdir(), 'pp-queue-cs-'));
  for (const [rel, src] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), src);
  }
  const profile: ExtractionProfile = {
    parserId: 'test-queue-call-shape',
    substrate: { language: 'ts', include: ['**/*.ts'], exclude: ['**/node_modules/**'] },
    entrypoints: QUEUE_RULE,
  };
  const { repo } = await runProfile(profile, dir, 'queue-cs-test');
  return repo;
}

/**
 * Engine warnings for this feature only — the baseline always emits its own
 * "node_modules not installed" warning in a temp-dir fixture.
 */
function unresolvedWarnings(repo: ParsedRepo): NonNullable<ParsedRepo['errors']> {
  return (repo.errors ?? []).filter((e) => e.severity === 'warning' && e.message.includes('unresolved'));
}

function queueDetails(repo: ParsedRepo): QueueEntrypointDetails[] {
  return repo.entrypoints
    .filter((e) => e.type === 'queue')
    .map((e) => e.details as QueueEntrypointDetails)
    .sort((a, b) => a.topic.localeCompare(b.topic));
}

const CONSUMER = (body: string) => `import { createKafkaConsumer } from './kafka.js';
${body}
`;

const KAFKA_LIB = `export function createKafkaConsumer(opts: { groupId: string; topic: string }): { topic: string } {
  return { topic: opts.topic };
}
`;

describe('call-shape queue entrypoints', () => {
  it('emits a literal topic unchanged, with a handler that resolves to a real function', async () => {
    const repo = await run({
      'kafka.ts': KAFKA_LIB,
      'consumer.ts': CONSUMER(`export function startConsumer() {
  return createKafkaConsumer({ groupId: 'g', topic: 'events-json' });
}`),
    });
    expect(queueDetails(repo)).toEqual([{ type: 'queue', system: 'kafka', topic: 'events-json' }]);
    const fnIds = new Set(repo.functions.map((f) => f.id));
    for (const ep of repo.entrypoints) expect(fnIds.has(ep.handlerId)).toBe(true);
    expect(unresolvedWarnings(repo)).toEqual([]);
  });

  it('folds a same-file module const into topicValue and keeps the token as topic', async () => {
    const repo = await run({
      'kafka.ts': KAFKA_LIB,
      'consumer.ts': CONSUMER(`const KAFKA_EVENTS = 'clickhouse_events_json';
export function startConsumer() {
  return createKafkaConsumer({ groupId: 'g', topic: KAFKA_EVENTS });
}`),
    });
    expect(queueDetails(repo)).toEqual([
      { type: 'queue', system: 'kafka', topic: 'KAFKA_EVENTS', topicValue: 'clickhouse_events_json' },
    ]);
    expect(unresolvedWarnings(repo)).toEqual([]);
  });

  it('folds an imported const through one import hop', async () => {
    const repo = await run({
      'kafka.ts': KAFKA_LIB,
      'topics.ts': `export const KAFKA_COHORT_CHANGED = 'cohort_membership_changed';`,
      // Extension-less relative specifier, the shape the repo value resolver indexes
      // (a `./topics.js` NodeNext specifier is a separate, pre-existing resolver gap).
      'consumer.ts': `import { createKafkaConsumer } from './kafka';
import { KAFKA_COHORT_CHANGED } from './topics';
export function startConsumer() {
  return createKafkaConsumer({ groupId: 'g', topic: KAFKA_COHORT_CHANGED });
}`,
    });
    expect(queueDetails(repo)).toEqual([
      { type: 'queue', system: 'kafka', topic: 'KAFKA_COHORT_CHANGED', topicValue: 'cohort_membership_changed' },
    ]);
    expect(unresolvedWarnings(repo)).toEqual([]);
  });

  it('emits an unresolved-but-visible entrypoint for a config-member topic, with a warning', async () => {
    const repo = await run({
      'kafka.ts': KAFKA_LIB,
      'consumer.ts': CONSUMER(`export function startConsumer(config: { LEGACY_TOPIC: string }) {
  return createKafkaConsumer({ groupId: 'g', topic: config.LEGACY_TOPIC });
}`),
    });
    expect(queueDetails(repo)).toEqual([{ type: 'queue', system: 'kafka', topic: 'unresolved:config.LEGACY_TOPIC' }]);
    const warnings = unresolvedWarnings(repo);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].file).toBe('consumer.ts');
    expect(warnings[0].message).toContain('topic');
    expect(warnings[0].message).toContain('createKafkaConsumer');
    expect(warnings[0].message).toContain('config.LEGACY_TOPIC');
  });

  it('resolves a shorthand { topic } property when it names a module const', async () => {
    const repo = await run({
      'kafka.ts': KAFKA_LIB,
      'consumer.ts': CONSUMER(`const topic = 'shorthand_topic';
const groupId = 'g';
export function startConsumer() {
  return createKafkaConsumer({ groupId, topic });
}`),
    });
    expect(queueDetails(repo)).toEqual([
      { type: 'queue', system: 'kafka', topic: 'topic', topicValue: 'shorthand_topic' },
    ]);
  });

  it('emits an unresolved entrypoint for a shorthand { topic } bound to a runtime param', async () => {
    const repo = await run({
      'kafka.ts': KAFKA_LIB,
      'consumer.ts': CONSUMER(`export function startConsumer(groupId: string, topic: string) {
  return createKafkaConsumer({ groupId, topic });
}`),
    });
    expect(queueDetails(repo)).toEqual([{ type: 'queue', system: 'kafka', topic: 'unresolved:topic' }]);
    expect(unresolvedWarnings(repo)).toHaveLength(1);
  });

  it('records one warning per rule per file, carrying the unresolved site count', async () => {
    const repo = await run({
      'kafka.ts': KAFKA_LIB,
      'a.ts': CONSUMER(`export function a1(config: { A: string; B: string }) {
  createKafkaConsumer({ groupId: 'g', topic: config.A });
  createKafkaConsumer({ groupId: 'g', topic: config.B });
}`),
      'b.ts': CONSUMER(`export function b1(config: { C: string }) {
  createKafkaConsumer({ groupId: 'g', topic: config.C });
}`),
    });
    expect(queueDetails(repo)).toHaveLength(3);
    const warnings = unresolvedWarnings(repo);
    expect(warnings.map((w) => w.file).sort()).toEqual(['a.ts', 'b.ts']);
    expect(warnings.find((w) => w.file === 'a.ts')?.message).toContain('2 site');
    expect(warnings.find((w) => w.file === 'b.ts')?.message).toContain('1 site');
  });

  it('skips a call with no topic property at all (the rule does not describe this call)', async () => {
    const repo = await run({
      'kafka.ts': KAFKA_LIB,
      'consumer.ts': CONSUMER(`export function startConsumer(opts: { groupId: string; topic: string }) {
  return createKafkaConsumer(opts);
}`),
    });
    expect(queueDetails(repo)).toEqual([]);
    expect(unresolvedWarnings(repo)).toEqual([]);
  });
});
