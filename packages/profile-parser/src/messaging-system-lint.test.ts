import { describe, expect, it } from 'vitest';
import { lintMessagingSystems } from './messaging-system-lint.js';

describe('lintMessagingSystems', () => {
  // The exact shape of the nine pilot profiles: a second queue rule that
  // DOES match the publisher, which is why set-intersection logic stayed silent.
  it('catches the pilot drift even though one consumer rule matches the publisher', () => {
    const warnings = lintMessagingSystems({
      entrypoints: [
        { kind: 'queue', system: 'gcp-pubsub' },
        { kind: 'queue', system: 'google-pubsub' },
      ],
      externalCalls: [{ kind: 'queue', system: 'gcp-pubsub' }],
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.pair).toEqual(['gcp-pubsub', 'google-pubsub']);
    expect(warnings[0]?.sharedToken).toBe('pubsub');
  });

  it('catches drift split across the consumer and producer sides', () => {
    const warnings = lintMessagingSystems({
      entrypoints: [{ kind: 'queue', system: 'google-pubsub' }],
      externalCalls: [{ kind: 'queue', system: 'gcp-pubsub' }],
    });
    expect(warnings).toHaveLength(1);
  });

  it('stays silent for genuinely different buses', () => {
    expect(
      lintMessagingSystems({
        entrypoints: [{ kind: 'queue', system: 'kafka' }],
        externalCalls: [{ kind: 'queue', system: 'sqs' }],
      }),
    ).toEqual([]);
  });

  it('normalizes case and whitespace, so one bus spelled two ways is ONE system', () => {
    expect(
      lintMessagingSystems({
        entrypoints: [{ kind: 'queue', system: '  KAFKA ' }],
        externalCalls: [{ kind: 'queue', system: 'kafka' }],
      }),
    ).toEqual([]);
  });

  it('stays silent when a profile declares a single system', () => {
    expect(
      lintMessagingSystems({
        entrypoints: [{ kind: 'queue', system: 'kafka' }],
        externalCalls: [{ kind: 'sdk' }],
      }),
    ).toEqual([]);
  });

  it('stays silent when a profile declares no queue rules at all', () => {
    expect(lintMessagingSystems({})).toEqual([]);
    expect(lintMessagingSystems({ entrypoints: [{ kind: 'http' }] })).toEqual([]);
  });

  it('ignores object-shaped entrypoint config used by non-TS language profiles', () => {
    expect(
      lintMessagingSystems({
        entrypoints: { queue: { enabled: true } },
        egress: { clientModules: ['requests'] },
      }),
    ).toEqual([]);
  });

  it('ignores the system field on non-queue rules', () => {
    expect(
      lintMessagingSystems({
        entrypoints: [
          { kind: 'http', system: 'gcp-pubsub' },
          { kind: 'queue', system: 'google-pubsub' },
        ],
        externalCalls: [],
      }),
    ).toEqual([]);
  });

  it('reports each confusable pair once', () => {
    const warnings = lintMessagingSystems({
      entrypoints: [
        { kind: 'queue', system: 'gcp-pubsub' },
        { kind: 'queue', system: 'google-pubsub' },
        { kind: 'queue', system: 'aws-pubsub' },
      ],
      externalCalls: [],
    });
    expect(warnings).toHaveLength(3);
    expect(warnings.map((w) => w.pair)).toEqual([
      ['aws-pubsub', 'gcp-pubsub'],
      ['aws-pubsub', 'google-pubsub'],
      ['gcp-pubsub', 'google-pubsub'],
    ]);
  });
});
