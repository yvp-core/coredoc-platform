import { readFileSync } from 'node:fs';
import {
  INTENT_ID_MAX_LENGTH,
  INTENT_LIMITS,
  IntentKind,
  IntentSourceKind,
  validateIntentPayload,
} from '@coredoc/core';
import { describe, expect, it } from 'vitest';
import { parseContract } from './intent-content.js';
import { IntentErrorCode, IntentPublicException } from './intent-errors.js';
import {
  INTENT_CONTRACT_LIMITS,
  IntentSourceSchema,
  externalUrl,
  itemVersion,
  slugId,
  text,
} from './intent-primitives.js';

/**
 * {@link INTENT_CONTRACT_LIMITS} TAKES its shared bounds from core's
 * `INTENT_LIMITS`, so a number cannot drift. What can still drift is the
 * MAPPING — which core bound governs which cloud field.
 */
describe('INTENT_CONTRACT_LIMITS maps onto the core intent bounds', () => {
  it('points each field at the core bound that governs it', () => {
    expect(INTENT_CONTRACT_LIMITS).toMatchObject({
      title: INTENT_LIMITS.title,
      statement: INTENT_LIMITS.statement,
      text: INTENT_LIMITS.text,
      id: INTENT_LIMITS.id,
      ref: INTENT_LIMITS.ref,
      sourcesPerItem: INTENT_LIMITS.sourcesPerItem,
      anchorsPerItem: INTENT_LIMITS.anchorsPerItem,
      repoKey: INTENT_LIMITS.id,
      nodeId: INTENT_LIMITS.ref,
    });
  });

  it('bounds payload text exactly where the core payload validator does', () => {
    const payload = (n: number) => ({ outcome: 'x'.repeat(n), beneficiary: 'b', boundary: 'y' });
    expect(validateIntentPayload(IntentKind.Capability, payload(INTENT_CONTRACT_LIMITS.text))).toEqual([]);
    expect(validateIntentPayload(IntentKind.Capability, payload(INTENT_CONTRACT_LIMITS.text + 1))).not.toEqual([]);
  });

  it('takes the slug id cap straight from core rather than mirroring it', () => {
    expect(INTENT_CONTRACT_LIMITS.slugId).toBe(INTENT_ID_MAX_LENGTH);
  });
});

/**
 * The other half of the mirror: every bound is also a COLUMN WIDTH.
 *
 * A contract bound looser than the `VARCHAR(n)` its value lands in does not
 * make the server more permissive — it converts a §12 refusal that names the
 * offending field into a Postgres `22001` and a 500 that names nothing. Two
 * bounds shipped that way: `repoKey` at 256 over a VARCHAR(200), and `nodeId`
 * at 2000 over a VARCHAR(500).
 *
 * The widths are read out of the migration rather than restated, so widening a
 * column and forgetting the contract (or the reverse) fails here.
 */
describe('INTENT_CONTRACT_LIMITS fits inside the columns it writes to', () => {
  const migration = readFileSync(
    new URL('../../../../prisma/migrations/20260901101000_add_intent_schema/migration.sql', import.meta.url),
    'utf8',
  );

  /** `{ 'intent_anchors.node_id': 500, … }` for every VARCHAR column in the intent schema. */
  const columnWidths = new Map<string, number>();
  for (const [, table, body] of migration.matchAll(/CREATE TABLE "(\w+)" \(([\s\S]*?)\n\);/g)) {
    for (const [, column, width] of (body as string).matchAll(/"(\w+)" VARCHAR\((\d+)\)/g)) {
      columnWidths.set(`${table}.${column}`, Number(width));
    }
  }

  it('parsed the migration, so an empty sweep cannot pass as a green one', () => {
    expect(columnWidths.size).toBeGreaterThan(20);
    expect(columnWidths.get('intent_anchors.node_id')).toBe(500);
  });

  it.each([
    ['title', INTENT_CONTRACT_LIMITS.title, ['intent_domains.title', 'intent_features.title', 'intent_items.title']],
    [
      'statement',
      INTENT_CONTRACT_LIMITS.statement,
      ['intent_domains.statement', 'intent_features.statement', 'intent_items.statement'],
    ],
    [
      'text',
      INTENT_CONTRACT_LIMITS.text,
      [
        'intent_items.rationale',
        'intent_anchors.rationale',
        'intent_feature_seeds.note',
        'intent_authority_transitions.reason',
      ],
    ],
    [
      'id',
      INTENT_CONTRACT_LIMITS.id,
      [
        'intent_mutation_requests.idempotency_key',
        'intent_item_sources.local_id',
        'intent_item_sources.revision',
        'intent_authority_transitions.source_local_id',
        'intent_authority_transitions.source_revision',
        'intent_audit_events.entity_id',
      ],
    ],
    [
      'slugId',
      INTENT_CONTRACT_LIMITS.slugId,
      ['intent_domains.id', 'intent_features.id', 'intent_items.id', 'intent_anchors.item_id'],
    ],
    [
      'ref',
      INTENT_CONTRACT_LIMITS.ref,
      ['intent_item_sources.ref', 'intent_item_sources.locator', 'intent_authority_transitions.source_ref'],
    ],
    ['repoKey', INTENT_CONTRACT_LIMITS.repoKey, ['intent_anchors.repo_key', 'intent_feature_seeds.repo_key']],
    ['nodeId', INTENT_CONTRACT_LIMITS.nodeId, ['intent_anchors.node_id', 'intent_feature_seeds.node_id']],
    ['capturedVersionedId', INTENT_CONTRACT_LIMITS.capturedVersionedId, ['intent_anchors.captured_versioned_id']],
  ])('%s (%s) is no wider than every column it lands in', (_label, limit, columns) => {
    for (const column of columns as string[]) {
      const width = columnWidths.get(column);
      expect(width, `${column} is missing from the migration`).toBeDefined();
      expect(limit as number, `${_label} exceeds ${column} VARCHAR(${width})`).toBeLessThanOrEqual(width as number);
    }
  });

  /**
   * `capturedVersionedId` is a `nodeId` plus a version suffix, so it is NOT
   * inside its column merely because `nodeId` is. Both columns are 500, which
   * means a maximum-length node id leaves no room for the suffix — the residual
   * this assertion exists to keep visible.
   */
  it('records that a maximum-length node id leaves no room for a version suffix', () => {
    expect(INTENT_CONTRACT_LIMITS.capturedVersionedId).toBe(INTENT_CONTRACT_LIMITS.nodeId);
  });
});

describe('primitives', () => {
  it('trims and rejects whitespace-only text', () => {
    expect(parseContract(text(10), '  hi  ')).toBe('hi');
    expect(() => parseContract(text(10), '   ')).toThrow(IntentPublicException);
  });

  it('rejects a slug that is not lowercase-hyphenated', () => {
    expect(parseContract(slugId(), 'br-refund-window')).toBe('br-refund-window');
    for (const bad of ['BR-1', 'refund_window', '-refund', '1refund', 'refund--window']) {
      expect(() => parseContract(slugId(), bad)).toThrow(IntentPublicException);
    }
  });

  it('rejects a non-http url scheme', () => {
    expect(parseContract(externalUrl, 'https://example.com/x')).toBe('https://example.com/x');
    expect(() => parseContract(externalUrl, 'ftp://example.com/x')).toThrow(IntentPublicException);
    expect(() => parseContract(externalUrl, 'javascript:alert(1)')).toThrow(IntentPublicException);
  });

  it('rejects a zero or fractional version', () => {
    expect(parseContract(itemVersion, 3)).toBe(3);
    for (const bad of [0, -1, 1.5]) expect(() => parseContract(itemVersion, bad)).toThrow(IntentPublicException);
  });

  it('rejects an unknown key on a source', () => {
    try {
      parseContract(IntentSourceSchema, {
        kind: IntentSourceKind.Spec,
        ref: 'spec/ordering',
        localId: 'CAP-1',
        body: 'the whole spec text',
      });
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(IntentPublicException);
      expect((error as IntentPublicException).publicError.code).toBe(IntentErrorCode.SchemaViolation);
    }
  });
});
