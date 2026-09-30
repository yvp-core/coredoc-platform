import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { QueueEntrypointDetails } from '@coredoc/core/types';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExtractionProfile } from '../types.js';
import { runProfile } from './run.js';

let dir: string;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const profile: ExtractionProfile = {
  parserId: 'topic-resolution-test',
  substrate: { language: 'ts', include: ['**/*.ts'] },
  entrypoints: [
    {
      kind: 'queue',
      detect: { via: 'method-decorator', names: { EventPattern: 'event' } },
      system: 'gcp-pubsub',
      topic: { arg: 0, as: 'wrapped-enum-member', unwrapCalls: ['getTopicInNamespace'] },
    },
  ],
  externalCalls: [
    {
      kind: 'queue',
      receiverPattern: '/kafkaClient$/',
      methods: ['emit'],
      topic: { arg: 0, as: 'wrapped-enum-member', unwrapCalls: ['getTopicInNamespace'] },
      system: 'gcp-pubsub',
    },
  ],
};

const APP_SOURCE = `
import { Topics } from './topics';

declare function getTopicInNamespace(topic: string): string;
declare function EventPattern(topic: string): MethodDecorator;

export class EventsService {
  private kafkaClient: { emit(topic: string, body: unknown): void };

  @EventPattern(getTopicInNamespace(Topics.UserCreated))
  consume(): void {}

  publish(): void {
    this.kafkaClient.emit(getTopicInNamespace(Topics.UserCreated), {});
  }
}
`;

describe('wrapped topic literal resolution', () => {
  it('preserves stable source tokens and adds runtime values across relative imports', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pp-topic-'));
    writeFileSync(join(dir, 'app.ts'), APP_SOURCE);
    writeFileSync(join(dir, 'topics.ts'), `export enum Topics { UserCreated = 'user.created' }`);

    const first = (await runProfile(profile, dir, 'topic-test')).repo;
    const firstEntrypoint = first.entrypoints.find((ep) => ep.type === 'queue');
    const firstCall = first.externalCalls.find((call) => call.targetDescriptor?.protocol === 'messaging');

    expect(firstEntrypoint?.details).toMatchObject({
      topic: 'Topics.UserCreated',
      topicValue: 'user.created',
    });
    expect(firstCall?.targetDescriptor?.messaging).toEqual({
      system: 'gcp-pubsub',
      destination: 'Topics.UserCreated',
      destinationValue: 'user.created',
    });
    expect(firstCall?.targetPattern).toBe('user.created');

    writeFileSync(join(dir, 'topics.ts'), `export enum Topics { UserCreated = 'user.created.v2' }`);
    const second = (await runProfile(profile, dir, 'topic-test')).repo;
    const secondEntrypoint = second.entrypoints.find((ep) => ep.type === 'queue');
    const secondCall = second.externalCalls.find((call) => call.targetDescriptor?.protocol === 'messaging');

    expect((secondEntrypoint?.details as QueueEntrypointDetails).topicValue).toBe('user.created.v2');
    expect(secondCall?.targetDescriptor?.messaging?.destinationValue).toBe('user.created.v2');
    expect(secondEntrypoint?.id).toBe(firstEntrypoint?.id);
    expect(secondCall?.id).toBe(firstCall?.id);
    expect(secondEntrypoint?.versionedId).not.toBe(firstEntrypoint?.versionedId);
    expect(secondCall?.versionedId).not.toBe(firstCall?.versionedId);
  });
});
