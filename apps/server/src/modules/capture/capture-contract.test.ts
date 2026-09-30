import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  UnsupportedCaptureSchemaVersionError,
  validateCaptureEvent,
  validateCaptureProvisioningReport,
} from './capture-contract.js';

interface ContractCorpus {
  valid: Array<{ name: string; event: unknown }>;
  invalid: Array<{ name: string; event: unknown }>;
}

const corpus = JSON.parse(
  readFileSync(
    new URL('../../../../../vendor/coredoc-workflows-runtime/runtime/capture/contract-corpus.json', import.meta.url),
    'utf8',
  ),
) as ContractCorpus;

describe('capture v1 contract', () => {
  for (const fixture of corpus.valid) {
    it(`accepts shared fixture: ${fixture.name}`, () => {
      expect(validateCaptureEvent(fixture.event)).toEqual(fixture.event);
    });
  }

  for (const fixture of corpus.invalid) {
    it(`rejects shared fixture: ${fixture.name}`, () => {
      expect(() => validateCaptureEvent(fixture.event)).toThrow();
    });
  }
});

describe('capture v2 workflow contract', () => {
  const base = {
    schemaVersion: 2,
    eventId: '33333333-3333-4333-8333-333333333333',
    occurredAt: '2026-08-16T12:00:00.000Z',
    host: 'claude-code',
    sessionId: 'session-42',
    runId: 'cdr-20260816-a1b2c3',
  };

  it('accepts an ordered declaration and canonical client task id', () => {
    const event = {
      ...base,
      taskId: 'cdt_11111111-1111-4111-8111-111111111111',
      type: 'workflow.run.started',
      data: {
        workflowId: 'change:large:normal',
        intent: 'change',
        risk: 'normal',
        scale: 'large',
        stages: [
          { stageId: 'spec', after: [] },
          { stageId: 'implement', after: ['spec'] },
          { stageId: 'verify', after: ['spec', 'implement'] },
        ],
      },
    };

    expect(validateCaptureEvent(event)).toEqual(event);
  });

  it('normalizes canonical V2 task and occurrence UUIDs without changing V1 task ids', () => {
    expect(
      validateCaptureEvent({
        ...base,
        eventId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
        taskId: 'cdt_BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB',
        type: 'workflow.run.started',
        data: { workflowId: 'change', intent: 'change', risk: 'normal', scale: 'normal', stages: [] },
      }),
    ).toMatchObject({
      eventId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      taskId: 'cdt_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    });
    expect(
      validateCaptureEvent({
        ...base,
        eventId: 'CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC',
        type: 'workflow.stage.started',
        data: { occurrenceId: 'DDDDDDDD-DDDD-4DDD-8DDD-DDDDDDDDDDDD', stageId: 'spec', attempt: 1 },
      }),
    ).toMatchObject({
      eventId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      data: { occurrenceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' },
    });
    expect(
      validateCaptureEvent({
        ...base,
        schemaVersion: 1,
        taskId: 'Opaque_Task:42',
        type: 'workflow.run.started',
        data: { workflowId: 'change', intent: 'change', risk: 'normal', scale: 'normal' },
      }),
    ).toMatchObject({ taskId: 'Opaque_Task:42' });
  });

  it.each([
    [
      { stageId: 'implement', after: ['spec'] },
      { stageId: 'spec', after: [] },
    ],
    [
      { stageId: 'spec', after: [] },
      { stageId: 'spec', after: [] },
    ],
    [
      { stageId: 'spec', after: [] },
      { stageId: 'implement', after: ['spec', 'spec'] },
    ],
  ])('rejects a contradictory stage declaration', (stages) => {
    expect(() =>
      validateCaptureEvent({
        ...base,
        type: 'workflow.run.started',
        data: {
          workflowId: 'change:large:normal',
          intent: 'change',
          risk: 'normal',
          scale: 'large',
          stages,
        },
      }),
    ).toThrow();
  });

  it.each([
    {
      ...base,
      type: 'workflow.stage.started',
      data: { occurrenceId: '44444444-4444-4444-8444-444444444444', stageId: 'spec', attempt: 1 },
    },
    {
      ...base,
      type: 'workflow.stage.finished',
      data: {
        occurrenceId: '44444444-4444-4444-8444-444444444444',
        stageId: 'spec',
        attempt: 1,
        outcome: 'success',
      },
    },
    {
      ...base,
      type: 'workflow.run.finished',
      data: { outcome: 'success', counters: { verificationRuns: 1 } },
    },
  ])('accepts a bounded V2 event', (event) => {
    expect(validateCaptureEvent(event)).toEqual(event);
  });

  it.each([
    {
      ...base,
      taskId: 'legacy-opaque-task',
      type: 'workflow.run.started',
      data: { workflowId: 'change', intent: 'change', risk: 'normal', scale: 'normal', stages: [] },
    },
    {
      ...base,
      type: 'capability.used',
      data: { kind: 'skill', capabilityId: 'coredoc-spec', outcome: 'success' },
    },
    {
      ...base,
      type: 'workflow.stage.started',
      data: { occurrenceId: '44444444-4444-4444-8444-444444444444', stageId: 'spec', attempt: 0 },
    },
    {
      ...base,
      type: 'workflow.stage.finished',
      data: {
        occurrenceId: '44444444-4444-4444-8444-444444444444',
        stageId: 'spec',
        attempt: 1,
        outcome: 'unknown',
      },
    },
  ])('rejects an unsupported V2 shape', (event) => {
    expect(() => validateCaptureEvent(event)).toThrow();
  });
});

describe('capture v3 workflow start contract', () => {
  const base = {
    schemaVersion: 3,
    eventId: '66666666-6666-4666-8666-666666666666',
    occurredAt: '2026-08-16T12:00:00.000Z',
    host: 'claude-code',
    sessionId: 'session-42',
    runId: 'cdr-20260816-a1b2c3',
    type: 'workflow.run.started',
  };
  const startData = {
    workflowId: 'change:large:normal',
    intent: 'change',
    risk: 'normal',
    scale: 'large',
    stages: [{ stageId: 'implement', after: [] }],
  };

  it('canonicalizes a direct bounded work-item set without treating display keys as identity', () => {
    const event = {
      ...base,
      data: {
        ...startData,
        workItems: [
          { provider: 'linear', externalId: 'LIN-42', externalKey: 'ENG-42' },
          { provider: 'jira', externalId: '10042' },
          { provider: 'jira', externalId: '10042', externalKey: 'CORE-123' },
        ],
      },
    };

    expect(validateCaptureEvent(event)).toEqual({
      ...event,
      data: {
        ...event.data,
        workItems: [
          { provider: 'jira', externalId: '10042', externalKey: 'CORE-123' },
          { provider: 'linear', externalId: 'LIN-42', externalKey: 'ENG-42' },
        ],
      },
    });
  });

  it.each([
    ['an empty set', { ...base, data: { ...startData, workItems: [] } }],
    [
      'more than eight raw entries even when they are duplicates',
      {
        ...base,
        data: {
          ...startData,
          workItems: Array.from({ length: 9 }, () => ({ provider: 'jira', externalId: '10042' })),
        },
      },
    ],
    ['an unsafe provider', { ...base, data: { ...startData, workItems: [{ provider: 'Jira', externalId: '10042' }] } }],
    [
      'an unsafe immutable id',
      { ...base, data: { ...startData, workItems: [{ provider: 'jira', externalId: '10042;rm' }] } },
    ],
    [
      'an unsafe display key',
      {
        ...base,
        data: {
          ...startData,
          workItems: [{ provider: 'jira', externalId: '10042', externalKey: '$(private)' }],
        },
      },
    ],
    [
      'conflicting display keys for one identity',
      {
        ...base,
        data: {
          ...startData,
          workItems: [
            { provider: 'jira', externalId: '10042', externalKey: 'CORE-123' },
            { provider: 'jira', externalId: '10042', externalKey: 'RENAMED-9' },
          ],
        },
      },
    ],
    [
      'an explicit canonical task id',
      {
        ...base,
        taskId: 'cdt_11111111-1111-4111-8111-111111111111',
        data: { ...startData, workItems: [{ provider: 'jira', externalId: '10042' }] },
      },
    ],
    ['a non-start V3 type', { ...base, type: 'workflow.run.finished', data: { outcome: 'success' } }],
    [
      'an unknown start-data field',
      {
        ...base,
        data: {
          ...startData,
          approvalGranted: true,
          workItems: [{ provider: 'jira', externalId: '10042' }],
        },
      },
    ],
    [
      'an unknown work-item field',
      {
        ...base,
        data: {
          ...startData,
          workItems: [{ provider: 'jira', externalId: '10042', title: 'private' }],
        },
      },
    ],
  ])('rejects %s', (_label, event) => {
    expect(() => validateCaptureEvent(event)).toThrow();
  });

  it('keeps the V2 start data contract closed to workItems', () => {
    expect(() =>
      validateCaptureEvent({
        ...base,
        schemaVersion: 2,
        data: { ...startData, workItems: [{ provider: 'jira', externalId: '10042' }] },
      }),
    ).toThrow();
  });
});

describe('capture provisioning report contract', () => {
  it.each([
    {
      schemaVersion: 1,
      host: 'claude-code',
      target: { kind: 'repository', repoKey: 'graph-hash', repositoryKey: 'owner/repo' },
      state: 'configured',
      pendingCount: 2,
      errorCode: 'OUTBOX_PENDING',
      attributionPendingCount: 0,
      attributionRejectedCount: 0,
      attributionLastClaimAt: null,
    },
    {
      schemaVersion: 1,
      host: 'codex',
      target: { kind: 'repository', repoKey: 'graph-hash', repositoryKey: 'owner/repo', profileName: null },
      state: 'disabled',
      pendingCount: 0,
      errorCode: null,
      attributionPendingCount: 0,
      attributionRejectedCount: 0,
      attributionLastClaimAt: null,
    },
  ])('accepts an exact bounded report', (report) => {
    expect(validateCaptureProvisioningReport(report)).toEqual(report);
  });

  it.each([
    {
      schemaVersion: 1,
      host: 'claude-code',
      target: { kind: 'repository', repoKey: 'graph-hash', repositoryKey: 'owner/repo', path: '/private' },
      state: 'configured',
      pendingCount: 0,
      errorCode: null,
    },
    {
      schemaVersion: 1,
      host: 'codex',
      target: { kind: 'profile', profileName: 'pilot' },
      state: 'configured',
      pendingCount: 0,
      errorCode: null,
    },
    {
      schemaVersion: 1,
      host: 'codex',
      target: { kind: 'profile', profileName: 'pilot' },
      state: 'disabled',
      pendingCount: 1,
      errorCode: null,
    },
    {
      schemaVersion: 1,
      host: 'codex',
      target: { kind: 'profile', profileName: 'base' },
      state: 'configured',
      pendingCount: 0,
      errorCode: null,
    },
    {
      schemaVersion: 2,
      host: 'codex',
      target: { kind: 'profile', profileName: 'pilot' },
      state: 'configured',
      pendingCount: 0,
      errorCode: null,
    },
  ])('rejects an unsupported or contradictory report', (report) => {
    expect(() => validateCaptureProvisioningReport(report)).toThrow();
  });
});

describe('capture v4 question contract', () => {
  const event = {
    schemaVersion: 4,
    eventId: '66666666-6666-4666-8666-666666666666',
    occurredAt: '2026-09-08T10:00:00.000Z',
    host: 'claude-code',
    sessionId: 'session-42',
    type: 'workflow.question.answered',
    data: {
      askId: '77777777-7777-4777-8777-777777777777',
      questionIndex: 1,
      questionCount: 1,
      question: 'Backfill existing rows?\nOne migration or two?',
      options: [{ label: 'One' }, { label: 'Two', description: 'Separate data step' }],
      multiSelect: false,
      answer: 'Two',
      answerKind: 'option',
    },
  };

  it('normalizes a session-scoped question and keeps run and stage optional', () => {
    expect(validateCaptureEvent(event)).toEqual(event);
    const inRun = { ...event, runId: 'cdr-20260908-a1b2c3', data: { ...event.data, stageId: 'spec' } };
    expect(validateCaptureEvent(inRun)).toEqual(inRun);
  });

  it('admits only the question event under schema 4 and no task attribution', () => {
    expect(() => validateCaptureEvent({ ...event, type: 'capability.used' })).toThrow(
      /schemaVersion 4 supports only workflow\.question\.answered/,
    );
    expect(() => validateCaptureEvent({ ...event, schemaVersion: 2 })).toThrow(/Unsupported capture event type/);
    expect(() => validateCaptureEvent({ ...event, taskId: 'cdt_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })).toThrow(
      /taskId is not supported/,
    );
    expect(() => validateCaptureEvent({ ...event, schemaVersion: 5 })).toThrow(UnsupportedCaptureSchemaVersionError);
  });

  it('bounds every text field and still refuses content-shaped keys', () => {
    expect(() => validateCaptureEvent({ ...event, data: { ...event.data, question: 'q'.repeat(501) } })).toThrow(
      /question must be text of 1 to 500/,
    );
    expect(() => validateCaptureEvent({ ...event, data: { ...event.data, answer: 'yes\r\nrm -rf' } })).toThrow(
      /answer must be text/,
    );
    expect(() =>
      validateCaptureEvent({
        ...event,
        data: { ...event.data, options: Array.from({ length: 11 }, (_, i) => ({ label: `o${i}` })) },
      }),
    ).toThrow(/at most 10 entries/);
    expect(() => validateCaptureEvent({ ...event, data: { ...event.data, questionIndex: 2 } })).toThrow(
      /questionIndex must be an integer between 1 and 1/,
    );
    expect(() => validateCaptureEvent({ ...event, data: { ...event.data, toolResponse: 'raw' } })).toThrow(
      /must not contain response/,
    );
    expect(() => validateCaptureEvent({ ...event, data: { ...event.data, answerKind: 'free-form' } })).toThrow(
      /Unsupported answerKind/,
    );
  });
});
