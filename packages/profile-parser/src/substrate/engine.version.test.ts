/**
 * Unit tests for the shared entity version-seed helper used by the
 * prisma / decorator / factory entity paths in the substrate engine.
 *
 * The seed must fold column/relation content in, so a field-type/flag change
 * that doesn't move the declaration line still flips the entity's versionedId.
 * The incremental cloud diff compares versionedId only; without this the diff
 * would keep stale columns when a model's class/line is untouched. The Ruby
 * (schema.rb) path is guarded separately in ruby-entities.test.ts.
 */

import { StableIdGenerator } from '@coredoc/core';
import { describe, expect, it } from 'vitest';
import { entityVersionSeed } from './engine.js';

const ID = new StableIdGenerator('/demo', 'demo');

describe('entityVersionSeed — column/relation content drives the version hash', () => {
  // Same name + declaration line across both parses; only the schema content
  // differs — exactly the case a line-only seed would miss.
  const PREFIX = 'User:42';
  const fieldsWithNullable = (nullable: boolean) => [
    { name: 'email', columnName: 'email', type: { text: 'string' }, isNullable: nullable, isUnique: true },
  ];
  const relations = [{ name: 'posts', type: 'one-to-many', targetEntityName: 'Post' }];
  const entityId = ID.entityId('src/user.ts', 'User');

  it('flips versionedId when only a column flag changes (name + line unchanged)', () => {
    const a = ID.versionedId(entityId, entityVersionSeed(PREFIX, fieldsWithNullable(false), relations));
    const b = ID.versionedId(entityId, entityVersionSeed(PREFIX, fieldsWithNullable(true), relations));
    expect(a).not.toBe(b);
  });

  it('flips versionedId when relations change but columns + line do not', () => {
    const a = ID.versionedId(entityId, entityVersionSeed(PREFIX, fieldsWithNullable(false), relations));
    const b = ID.versionedId(entityId, entityVersionSeed(PREFIX, fieldsWithNullable(false), []));
    expect(a).not.toBe(b);
  });

  it('is stable for identical content (no spurious churn between parses)', () => {
    const a = entityVersionSeed(PREFIX, fieldsWithNullable(false), relations);
    const b = entityVersionSeed(PREFIX, fieldsWithNullable(false), relations);
    expect(a).toBe(b);
  });

  it('produces the exact `prefix:{json}` shape the three engine sites build', () => {
    // Pins the serialization format: an accidental shape change would re-hash
    // every entity in every repo on the next push, not just the changed ones.
    expect(entityVersionSeed('User:42', [{ a: 1 }], [{ b: 2 }])).toBe(
      'User:42:{"fields":[{"a":1}],"relations":[{"b":2}]}',
    );
  });
});
