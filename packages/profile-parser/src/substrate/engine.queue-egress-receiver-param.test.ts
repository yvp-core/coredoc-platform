/**
 * Queue egress (SF-008 C-7): a matcher's `receiver`/`receiverPattern` gates which `.send`
 * it claims, and a topic that is a PARAMETER of the enclosing method resolves from each
 * direct in-repo caller's argument at that position — one hop, one edge per distinct topic.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

const PRELUDE = `import { Topics } from './topics';

declare function getTopicInNamespace(topic: string): string;
type Sender = { send(record: unknown): Promise<void> };
`;

async function run(source: string, topic: ArgRef): Promise<ParsedRepo> {
  dir = mkdtempSync(join(tmpdir(), 'pp-queue-egress-'));
  // Callers resolve through SCIP, whose prerequisite check is node_modules + a tsconfig.
  mkdirSync(join(dir, 'node_modules'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'queue-egress-fixture', version: '1.0.0' }));
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { target: 'ES2022' }, include: ['*.ts'] }),
  );
  writeFileSync(
    join(dir, 'topics.ts'),
    `export enum Topics { WidgetCreated = 'widget.created', WidgetDeleted = 'widget.deleted' }`,
  );
  writeFileSync(join(dir, 'app.ts'), `${PRELUDE}\n${source}`);
  const profile: ExtractionProfile = {
    parserId: 'test-queue-egress',
    substrate: { language: 'ts', include: ['**/*.ts'], exclude: ['**/node_modules/**'] },
    externalCalls: [{ kind: 'queue', receiverPattern: '/producer$/', methods: ['send'], topic, system: 'kafka' }],
  };
  const { repo } = await runProfile(profile, dir, 'queue-egress-test');
  return repo;
}

function messagingEdges(repo: ParsedRepo): NonNullable<ExternalCall['targetDescriptor']>['messaging'][] {
  return repo.externalCalls
    .filter((c) => c.targetDescriptor?.protocol === 'messaging')
    .map((c) => c.targetDescriptor?.messaging);
}

const OBJECT_TOPIC: ArgRef = { arg: 0, as: 'object-property', key: 'topic' };

describe('queue egress receiver check', () => {
  it('claims a .send on a matching receiver and ignores one on any other receiver', async () => {
    const repo = await run(
      `export class WidgetEvents {
  private producer!: Sender;
  private mailer!: Sender;

  publish(): void {
    void this.producer.send({ topic: 'widget-events' });
    void this.mailer.send({ topic: 'mail-out' });
  }
}`,
      OBJECT_TOPIC,
    );
    expect(messagingEdges(repo)).toEqual([{ system: 'kafka', destination: 'widget-events' }]);
  });
});

describe('queue egress topic passed through a method parameter — one caller hop', () => {
  const WRAPPED_OBJECT_TOPIC: ArgRef = {
    arg: 0,
    as: 'object-property',
    key: 'topic',
    unwrapCalls: ['getTopicInNamespace'],
  };

  it('emits one edge per distinct topic its direct callers pass, wrapped or bare', async () => {
    const repo = await run(
      `export class WidgetEvents {
  private producer!: Sender;

  private async publish(topic: string, body: unknown): Promise<void> {
    await this.producer.send({ topic, messages: [body] });
  }

  created(): Promise<void> {
    return this.publish(getTopicInNamespace(Topics.WidgetCreated), {});
  }

  deleted(): Promise<void> {
    return this.publish(Topics.WidgetDeleted, {});
  }

  createdAgain(): Promise<void> {
    return this.publish(getTopicInNamespace(Topics.WidgetCreated), {});
  }

  // Its own parameter: a second hop, out of bounds, so it contributes nothing.
  forward(topic: string): Promise<void> {
    return this.publish(topic, {});
  }
}`,
      WRAPPED_OBJECT_TOPIC,
    );
    expect(messagingEdges(repo)).toEqual([
      { system: 'kafka', destination: 'Topics.WidgetCreated', destinationValue: 'widget.created' },
      { system: 'kafka', destination: 'Topics.WidgetDeleted', destinationValue: 'widget.deleted' },
    ]);
  });

  it('reads an inline wrapped property value once unwrapCalls opts in', async () => {
    const source = `export class WidgetEvents {
  private producer!: Sender;

  publish(): Promise<void> {
    return this.producer.send({ topic: getTopicInNamespace(Topics.WidgetCreated) });
  }
}`;
    expect(messagingEdges(await run(source, OBJECT_TOPIC))).toEqual([]);
    expect(messagingEdges(await run(source, WRAPPED_OBJECT_TOPIC))).toEqual([
      { system: 'kafka', destination: 'Topics.WidgetCreated', destinationValue: 'widget.created' },
    ]);
  });
});
