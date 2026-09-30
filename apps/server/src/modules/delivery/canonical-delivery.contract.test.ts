import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { validateCanonicalExternalRefId } from './canonical-delivery-read.contract.js';
import {
  CoredocShipEvidenceSchema,
  DeliveryTaskEnsureSchema,
  TaskExternalRefAttachSchema,
  TaskExternalRefDetachSchema,
  TaskExternalRefUrlSchema,
  deliveryBodyError,
} from './canonical-delivery.contract.js';

const CONNECTOR_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MAX_SIGNED_BIGINT = '9223372036854775807';
const SHIP_EVENT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SHIPPED_AT = '2026-08-17T12:34:56.789Z';

/** The schemas are applied by `ZodValidationPipe`; here they are exercised directly. */
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new Error(result.error.issues[0].message);
  return result.data;
}

function rejection(schema: z.ZodType<unknown>, input: unknown): unknown {
  const result = schema.safeParse(input);
  if (result.success) throw new Error('Expected validation to reject');
  return deliveryBodyError(result.error);
}

function validAttach(overrides: Record<string, unknown> = {}) {
  return {
    provider: 'jira',
    externalId: '10042',
    connectorId: CONNECTOR_ID,
    makeAuthority: true,
    ...overrides,
  };
}

describe('CoredocShipEvidenceSchema', () => {
  it('accepts only an event identity and occurrence time, canonicalizing the UUID', () => {
    expect(
      parse(CoredocShipEvidenceSchema, {
        eventId: SHIP_EVENT_ID.toUpperCase(),
        shippedAt: SHIPPED_AT,
      }),
    ).toEqual({
      eventId: SHIP_EVENT_ID,
      shippedAt: SHIPPED_AT,
    });
  });

  it.each([
    '2026-02-30T12:34:56Z',
    '2026-02-31T12:34:56.789+05:30',
    '2026-08-17T24:00:00-04:00',
  ])('rejects an impossible ISO-8601 calendar or clock value: %s', (shippedAt) => {
    expect(() => parse(CoredocShipEvidenceSchema, { eventId: SHIP_EVENT_ID, shippedAt })).toThrow(
      'shippedAt must be an ISO-8601 timestamp',
    );
  });

  it.each([
    '2024-02-29T23:59:59.123456789+05:30',
    '2026-08-17T00:00:00.1-04:00',
    '2026-08-17T12:34:56+00:00',
  ])('preserves a valid ISO-8601 offset and fractional-precision timestamp: %s', (shippedAt) => {
    expect(parse(CoredocShipEvidenceSchema, { eventId: SHIP_EVENT_ID, shippedAt })).toEqual({
      eventId: SHIP_EVENT_ID,
      shippedAt,
    });
  });

  it.each([
    ['missing event identity', { shippedAt: SHIPPED_AT }],
    ['invalid event identity', { eventId: 'ship-42', shippedAt: SHIPPED_AT }],
    ['missing occurrence time', { eventId: SHIP_EVENT_ID }],
    ['date-only occurrence time', { eventId: SHIP_EVENT_ID, shippedAt: '2026-08-17' }],
    ['invalid calendar time', { eventId: SHIP_EVENT_ID, shippedAt: 'not-a-time' }],
    ['numeric occurrence time', { eventId: SHIP_EVENT_ID, shippedAt: Date.parse(SHIPPED_AT) }],
    ['free-form note', { eventId: SHIP_EVENT_ID, shippedAt: SHIPPED_AT, note: 'deployed to production' }],
    ['arbitrary payload', { eventId: SHIP_EVENT_ID, shippedAt: SHIPPED_AT, payload: { environment: 'prod' } }],
  ])('rejects an inexact Coredoc ship body: %s', (_label, body) => {
    expect(() => parse(CoredocShipEvidenceSchema, body)).toThrow();
  });
});

describe('TaskExternalRefAttachSchema', () => {
  it('accepts only the exact repair input and canonicalizes a connector UUID', () => {
    expect(parse(TaskExternalRefAttachSchema, validAttach({ connectorId: CONNECTOR_ID.toUpperCase() }))).toEqual({
      provider: 'jira',
      externalId: '10042',
      connectorId: CONNECTOR_ID,
      makeAuthority: true,
    });
  });

  it('accepts a null connector for a non-authoritative manual repair ref', () => {
    expect(parse(TaskExternalRefAttachSchema, validAttach({ connectorId: null, makeAuthority: false }))).toEqual({
      provider: 'jira',
      externalId: '10042',
      connectorId: null,
      makeAuthority: false,
    });
  });

  it('does not let a connector-less manual ref become lifecycle authority', () => {
    expect(() => parse(TaskExternalRefAttachSchema, validAttach({ connectorId: null, makeAuthority: true }))).toThrow(
      'A connector-less external reference cannot become lifecycle authority',
    );
  });

  it.each([
    ['missing provider', { externalId: '10042', connectorId: CONNECTOR_ID, makeAuthority: false }],
    ['invalid provider', validAttach({ provider: 'Jira Cloud' })],
    ['empty external ID', validAttach({ externalId: '' })],
    ['oversized external ID', validAttach({ externalId: 'x'.repeat(257) })],
    ['missing connector ID', { provider: 'jira', externalId: '10042', makeAuthority: false }],
    ['invalid connector ID', validAttach({ connectorId: 'connector-1' })],
    ['missing authority choice', { provider: 'jira', externalId: '10042', connectorId: CONNECTOR_ID }],
    ['non-boolean authority choice', validAttach({ makeAuthority: 'yes' })],
    ['unknown field', validAttach({ externalKey: 'CORE-42' })],
  ])('rejects %s', (_label, input) => {
    expect(() => parse(TaskExternalRefAttachSchema, input)).toThrow();
  });
});

describe('TaskExternalRefDetachSchema', () => {
  it('accepts an omitted fallback', () => {
    expect(parse(TaskExternalRefDetachSchema, {})).toEqual({});
  });

  it('accepts an exact Coredoc fallback', () => {
    expect(parse(TaskExternalRefDetachSchema, { fallbackAuthority: { kind: 'coredoc' } })).toEqual({
      fallbackAuthority: { kind: 'coredoc' },
    });
  });

  it('accepts an exact attached-ref fallback with its own positive decimal ID', () => {
    expect(
      parse(TaskExternalRefDetachSchema, {
        fallbackAuthority: { kind: 'external_ref', externalRefId: MAX_SIGNED_BIGINT },
      }),
    ).toEqual({
      fallbackAuthority: { kind: 'external_ref', externalRefId: MAX_SIGNED_BIGINT },
    });
  });

  // The `:externalRefId` path segment keeps its own validator, applied in the service.
  it.each([
    0,
    1,
    '',
    '0',
    '-1',
    '+1',
    '01',
    '1.0',
    ' 1',
    '9223372036854775808',
  ])('rejects non-canonical or out-of-range path ref ID %j', (externalRefId) => {
    expect(() => validateCanonicalExternalRefId(externalRefId)).toThrow(
      'externalRefId must be a positive bounded decimal string',
    );
  });

  it.each([
    ['unknown top-level field', { reason: 'cleanup' }],
    ['unknown fallback kind', { fallbackAuthority: { kind: 'connector' } }],
    ['missing fallback ref ID', { fallbackAuthority: { kind: 'external_ref' } }],
    ['invalid fallback ref ID', { fallbackAuthority: { kind: 'external_ref', externalRefId: '0' } }],
    ['extra Coredoc fallback field', { fallbackAuthority: { kind: 'coredoc', externalRefId: '43' } }],
    [
      'extra external-ref fallback field',
      {
        fallbackAuthority: { kind: 'external_ref', externalRefId: '43', provider: 'jira' },
      },
    ],
  ])('rejects an inexact detach body: %s', (_label, body) => {
    expect(() => parse(TaskExternalRefDetachSchema, body)).toThrow();
  });
});

describe('TaskExternalRefUrlSchema', () => {
  it('accepts a bounded HTTPS provider URL without secret-bearing components', () => {
    const url = 'https://jira.example.test/browse/CORE-42';
    expect(parse(TaskExternalRefUrlSchema, url)).toBe(url);
  });

  it('accepts exactly 2048 ASCII characters', () => {
    const prefix = 'https://jira.example.test/';
    const url = `${prefix}${'a'.repeat(2048 - prefix.length)}`;
    expect(url).toHaveLength(2048);
    expect(parse(TaskExternalRefUrlSchema, url)).toBe(url);
  });

  it.each([
    'http://jira.example.test/browse/CORE-42',
    'https://user:secret@jira.example.test/browse/CORE-42',
    'https://jira.example.test/browse/CORE-42?token=secret',
    'https://jira.example.test/browse/CORE-42#private',
  ])('rejects unsafe provider URL %s', (url) => {
    expect(() => parse(TaskExternalRefUrlSchema, url)).toThrow();
  });

  it('rejects a provider URL above the 2048-character boundary', () => {
    const prefix = 'https://jira.example.test/';
    const url = `${prefix}${'a'.repeat(2049 - prefix.length)}`;
    expect(url).toHaveLength(2049);
    expect(() => parse(TaskExternalRefUrlSchema, url)).toThrow();
  });
});

describe('DeliveryTaskEnsureSchema telemetry authority fence', () => {
  it('keeps the current telemetry producer wire: Coredoc authority and no external refs', () => {
    expect(
      parse(DeliveryTaskEnsureSchema, {
        repositoryKey: 'coredoc/coredoc-parser',
        lifecycle: 'active',
        authority: 'coredoc',
        externalRefs: [],
      }),
    ).toEqual({
      repositoryKey: 'coredoc/coredoc-parser',
      lifecycle: 'active',
      authority: 'coredoc',
      externalRefs: [],
    });
  });

  it.each([
    { authority: 'connector:jira', externalRefs: [] },
    {
      authority: 'coredoc',
      externalRefs: [
        {
          provider: 'jira',
          externalId: '10042',
          externalKey: 'CORE-42',
          externalUrl: 'https://jira.example.test/browse/CORE-42',
          externalState: 'In Progress',
        },
      ],
    },
  ])('rejects connector-owned telemetry input with a typed bounded-forbidden distinction', (input) => {
    const error = rejection(DeliveryTaskEnsureSchema, input);
    expect(error).toBeInstanceOf(ForbiddenException);
    expect(error).toMatchObject({
      response: { statusCode: 403, code: 'TASK_AUTHORITY_FORBIDDEN' },
    });
  });

  it('rejects client-supplied creator metadata as an unsupported field', () => {
    expect(() =>
      parse(DeliveryTaskEnsureSchema, {
        authority: 'coredoc',
        externalRefs: [],
        createdBy: `connector:${CONNECTOR_ID}`,
      }),
    ).toThrow('Unsupported delivery task ensure field: createdBy');
  });
});
