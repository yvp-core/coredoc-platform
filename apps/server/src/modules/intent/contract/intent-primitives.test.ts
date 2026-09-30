import { readFileSync } from 'node:fs';
import {
  INTENT_ID_MAX_LENGTH,
  INTENT_SCHEMA_VERSION,
  IntentAuthority,
  IntentKind,
  IntentSourceKind,
  validateIntentFile,
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
 * {@link INTENT_CONTRACT_LIMITS} now TAKES its shared bounds from core's
 * `INTENT_LIMITS`, so a number cannot drift. What can still drift is the
 * MAPPING — which core bound governs which cloud field. These tests probe
 * core's REAL enforcement per field through `validateIntentFile`, so a bound
 * re-pointed at the wrong core key fails HERE instead of the cloud quietly
 * accepting content the local overlay format would refuse.
 */
function coreAccepts(item: Record<string, unknown>): boolean {
  const result = validateIntentFile({
    schemaVersion: INTENT_SCHEMA_VERSION,
    projectId: 'limits-probe',
    domains: [{ id: 'probe', title: 'Probe' }],
    items: [
      {
        id: 'cap-probe',
        domain: 'probe',
        kind: IntentKind.Capability,
        title: 'Probe',
        statement: 'Probe',
        authority: IntentAuthority.Candidate,
        sources: [{ kind: IntentSourceKind.Spec, ref: 'probe', localId: 'probe' }],
        payload: { outcome: 'o', beneficiary: 'b', boundary: 'y' },
        ...item,
      },
    ],
    relations: [],
  });
  return result.ok;
}

describe('INTENT_CONTRACT_LIMITS mirrors the core intent bounds', () => {
  it.each([
    ['title', (n: number) => ({ title: 'x'.repeat(n) }), INTENT_CONTRACT_LIMITS.title],
    ['statement', (n: number) => ({ statement: 'x'.repeat(n) }), INTENT_CONTRACT_LIMITS.statement],
    [
      'payload text',
      (n: number) => ({ payload: { outcome: 'x'.repeat(n), beneficiary: 'b', boundary: 'y' } }),
      INTENT_CONTRACT_LIMITS.text,
    ],
    [
      'source ref',
      (n: number) => ({ sources: [{ kind: IntentSourceKind.Spec, ref: 'x'.repeat(n), localId: 'probe' }] }),
      INTENT_CONTRACT_LIMITS.ref,
    ],
  ])('%s is bounded at %s in core too', (_label, build, limit) => {
    expect(coreAccepts(build(limit as number))).toBe(true);
    expect(coreAccepts(build((limit as number) + 1))).toBe(false);
  });

  it('sourcesPerItem and anchorsPerItem match core', () => {
    const source = (index: number) => ({
      kind: IntentSourceKind.Spec,
      ref: `spec/${index}`,
      localId: `S-${index}`,
    });
    const anchor = (index: number) => ({
      repo: 'api',
      nodeId: `aaaa:function:src/a.ts:f${index}`,
      nodeType: 'function',
      capturedVersionedId: `aaaa:function:src/a.ts:f${index}@1`,
      rationale: 'probe',
    });
    const range = (count: number, make: (index: number) => unknown) => Array.from({ length: count }, (_, i) => make(i));

    expect(coreAccepts({ sources: range(INTENT_CONTRACT_LIMITS.sourcesPerItem, source) })).toBe(true);
    expect(coreAccepts({ sources: range(INTENT_CONTRACT_LIMITS.sourcesPerItem + 1, source) })).toBe(false);
    expect(coreAccepts({ codeAnchors: range(INTENT_CONTRACT_LIMITS.anchorsPerItem, anchor) })).toBe(true);
    expect(coreAccepts({ codeAnchors: range(INTENT_CONTRACT_LIMITS.anchorsPerItem + 1, anchor) })).toBe(false);
  });

  it('takes the slug id cap straight from core rather than mirroring it', () => {
    expect(INTENT_CONTRACT_LIMITS.slugId).toBe(INTENT_ID_MAX_LENGTH);
  });

  it('points the anchor coordinates at the core bounds that actually govern them', () => {
    const anchor = (repo: string, nodeId: string) => ({
      repo,
      nodeId,
      nodeType: 'function',
      capturedVersionedId: 'aaaa:function:src/a.ts:f@1',
      rationale: 'probe',
    });
    const repo = 'r'.repeat(INTENT_CONTRACT_LIMITS.repoKey);
    const nodeId = 'n'.repeat(INTENT_CONTRACT_LIMITS.nodeId);

    expect(coreAccepts({ codeAnchors: [anchor(repo, nodeId)] })).toBe(true);
    expect(coreAccepts({ codeAnchors: [anchor(`${repo}x`, 'n')] })).toBe(false);
    expect(coreAccepts({ codeAnchors: [anchor('r', `${nodeId}x`)] })).toBe(false);
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
