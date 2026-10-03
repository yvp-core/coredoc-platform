import { describe, expect, it } from 'vitest';
import { INTENT_ID_PREFIX_BY_KIND, IntentSourceKind, validateIntentPayload, type IntentKind } from '@coredoc/core';
import { SEED_SOURCE_REF, readSeedIntent, seedToWorkspaceDocument } from './seed-document.js';

const seed = readSeedIntent();
const document = seedToWorkspaceDocument(seed);

/** The keys the server's strict `ItemSchema` accepts (intent-workspace-import.ts). */
const ITEM_KEYS = new Set([
  'id',
  'kind',
  'domainId',
  'featureId',
  'title',
  'statement',
  'payload',
  'appliesWhen',
  'rationale',
  'body',
  'authority',
  'supersededById',
  'proposedSuccessorOfId',
  'sources',
]);

describe('seedToWorkspaceDocument', () => {
  it('produces a format-1 document whose revision is the content digest', () => {
    expect(document.formatVersion).toBe(1);
    expect(document.source.ref).toBe(SEED_SOURCE_REF);
    expect(document.source.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(seedToWorkspaceDocument(readSeedIntent()).source.revision).toBe(document.source.revision);
  });

  it('carries every domain and item, with the overlay domain as domainId', () => {
    expect(document.domains.map((domain) => domain.id)).toEqual(seed.domains.map((domain) => domain.id));
    expect(document.features).toEqual([]);
    expect(document.items).toHaveLength(seed.items.length);
    for (const [index, item] of document.items.entries()) {
      expect(item.domainId).toBe(seed.items[index]!.domain);
      expect(item.authority).toBe(seed.items[index]!.authority);
    }
  });

  it('keeps the authorities the corpus traps depend on', () => {
    const byAuthority = (authority: string) => document.items.filter((item) => item.authority === authority).length;
    expect(byAuthority('accepted')).toBe(7);
    expect(byAuthority('candidate')).toBe(2);
    expect(byAuthority('rejected')).toBe(1);
  });

  it('drops code anchors and item relations, which a workspace document cannot carry', () => {
    for (const item of document.items) {
      for (const key of Object.keys(item)) expect(ITEM_KEYS.has(key), key).toBe(true);
    }
    expect(Object.keys(document)).not.toContain('relations');
  });

  it('meets the rules the import validates per item: id prefix, payload, source kind', () => {
    const sourceKinds = new Set<string>(Object.values(IntentSourceKind));
    for (const item of document.items) {
      expect(item.id.startsWith(`${INTENT_ID_PREFIX_BY_KIND[item.kind as IntentKind]}-`), item.id).toBe(true);
      expect(validateIntentPayload(item.kind as IntentKind, item.payload ?? {}), item.id).toEqual([]);
      expect(item.sources.length).toBeGreaterThan(0);
      for (const source of item.sources) expect(sourceKinds.has(source.kind), source.kind).toBe(true);
    }
  });
});
