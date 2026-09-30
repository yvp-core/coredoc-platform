/**
 * Acceptance for the single in-scope hop that resolves a queue/egress topic passed
 * through a LOCAL binding (roadmap issue 10).
 *
 * A topic written inline resolves; the same topic assigned to a local `const` first
 * used to be recognized and then dropped for lack of a resolvable destination, so the
 * producer side of the graph looked empty. The engine now follows the binding to its
 * initializer — EXACTLY ONE hop, in-scope, non-reassigned — and re-applies the rule's
 * OWN declared argument mode to that initializer. No mode is invented and a failed hop
 * keeps the previous drop behaviour rather than fabricating a topic.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExternalCall, ParsedRepo } from '@coredoc/core/types';
import { afterEach, describe, expect, it } from 'vitest';
import type { ArgRef, ExtractionProfile } from '../types.js';
import { runProfile } from './run.js';

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const LITERAL_TOPIC: ArgRef = { arg: 0, as: 'string-literal' };
const WRAPPED_TOPIC: ArgRef = { arg: 0, as: 'wrapped-enum-member', unwrapCalls: ['getTopicInNamespace'] };

const PRELUDE = `import { Topics } from './topics';

declare function getTopicInNamespace(topic: string): string;
`;

async function run(body: string, topic: ArgRef): Promise<ParsedRepo> {
  dir = mkdtempSync(join(tmpdir(), 'pp-topic-binding-'));
  writeFileSync(join(dir, 'topics.ts'), `export enum Topics { UserCreated = 'user.created' }`);
  writeFileSync(
    join(dir, 'app.ts'),
    `${PRELUDE}
export class EventsService {
  private kafkaClient!: { emit(topic: string, body: unknown): void };

${body}
}
`,
  );
  const profile: ExtractionProfile = {
    parserId: 'test-topic-local-binding',
    substrate: { language: 'ts', include: ['**/*.ts'], exclude: ['**/node_modules/**'] },
    externalCalls: [
      { kind: 'queue', receiverPattern: '/kafkaClient$/', methods: ['emit'], topic, system: 'gcp-pubsub' },
    ],
  };
  const { repo } = await runProfile(profile, dir, 'topic-binding-test');
  return repo;
}

function messagingEdges(repo: ParsedRepo): NonNullable<ExternalCall['targetDescriptor']>['messaging'][] {
  return repo.externalCalls
    .filter((c) => c.targetDescriptor?.protocol === 'messaging')
    .map((c) => c.targetDescriptor?.messaging);
}

describe('queue topic through a local binding — one in-scope hop', () => {
  it('resolves a string literal bound to a local const, identically to the inline literal', async () => {
    const inline = await run(
      `  publish(): void {
    this.kafkaClient.emit('user-events', {});
  }`,
      LITERAL_TOPIC,
    );
    const bound = await run(
      `  publish(): void {
    const topic = 'user-events';
    this.kafkaClient.emit(topic, {});
  }`,
      LITERAL_TOPIC,
    );
    expect(messagingEdges(inline)).toEqual([{ system: 'gcp-pubsub', destination: 'user-events' }]);
    expect(messagingEdges(bound)).toEqual(messagingEdges(inline));
  });

  it('resolves a wrapped enum member bound to a local const', async () => {
    const repo = await run(
      `  publish(): void {
    const topic = getTopicInNamespace(Topics.UserCreated);
    this.kafkaClient.emit(topic, {});
  }`,
      WRAPPED_TOPIC,
    );
    expect(messagingEdges(repo)).toEqual([
      { system: 'gcp-pubsub', destination: 'Topics.UserCreated', destinationValue: 'user.created' },
    ]);
  });

  it('resolves an enum member bound to a local const inside the wrapper call', async () => {
    const repo = await run(
      `  publish(): void {
    const t = Topics.UserCreated;
    this.kafkaClient.emit(getTopicInNamespace(t), {});
  }`,
      WRAPPED_TOPIC,
    );
    expect(messagingEdges(repo)).toEqual([
      { system: 'gcp-pubsub', destination: 'Topics.UserCreated', destinationValue: 'user.created' },
    ]);
  });

  it('does not chase a second hop (a binding initialized from another local binding)', async () => {
    const repo = await run(
      `  publish(): void {
    const first = 'user-events';
    const second = first;
    this.kafkaClient.emit(second, {});
  }`,
      LITERAL_TOPIC,
    );
    expect(messagingEdges(repo)).toEqual([]);
  });

  it('does not resolve a reassigned binding', async () => {
    const repo = await run(
      `  publish(flag: boolean): void {
    let topic = 'user-events';
    if (flag) topic = 'other-events';
    this.kafkaClient.emit(topic, {});
  }`,
      LITERAL_TOPIC,
    );
    expect(messagingEdges(repo)).toEqual([]);
  });

  it('does not resolve a binding declared in a sibling scope', async () => {
    const repo = await run(
      `  other(): void {
    const topic = 'user-events';
    void topic;
  }

  publish(topic: string): void {
    this.kafkaClient.emit(topic, {});
  }`,
      LITERAL_TOPIC,
    );
    expect(messagingEdges(repo)).toEqual([]);
  });

  it('leaves a parameter and an imported name unresolved, exactly as before', async () => {
    const param = await run(
      `  publish(topic: string): void {
    this.kafkaClient.emit(topic, {});
  }`,
      LITERAL_TOPIC,
    );
    const imported = await run(
      `  publish(): void {
    this.kafkaClient.emit(Topics.UserCreated, {});
  }`,
      LITERAL_TOPIC,
    );
    expect(messagingEdges(param)).toEqual([]);
    expect(messagingEdges(imported)).toEqual([]);
  });

  it('keeps the inline wrapped-enum-member edge byte-identical', async () => {
    const repo = await run(
      `  publish(): void {
    this.kafkaClient.emit(getTopicInNamespace(Topics.UserCreated), {});
  }`,
      WRAPPED_TOPIC,
    );
    expect(messagingEdges(repo)).toEqual([
      { system: 'gcp-pubsub', destination: 'Topics.UserCreated', destinationValue: 'user.created' },
    ]);
  });
});
