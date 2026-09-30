/**
 * Acceptance for how weak-identity USES_TYPE rows read.
 *
 * Field evidence: the graph flags a member reference whose import specifier could not be resolved
 * to a repo file as `ambiguous` (name-matched only), but the rendered row read exactly like a
 * verified one — an agent could not tell a proven consumer from a name collision.
 */
import { TypeUseKind } from '@coredoc/db/types';
import type { TypeUsage } from '@coredoc/db/types';
import { describe, expect, it } from 'vitest';
import { memberValueUsageNote, typeUsageSummary } from './type-usage.js';

const row = (over: Partial<TypeUsage>): TypeUsage => ({
  id: 'h0:function:src/a.ts:isLocked',
  name: 'isLocked',
  type: 'function',
  filePath: 'src/a.ts',
  startLine: 4,
  usage: 'member-access',
  useKind: TypeUseKind.Value,
  member: 'Locked',
  ambiguous: false,
  ...over,
});

describe('typeUsageSummary', () => {
  it('marks a row whose identity was only name-matched', () => {
    expect(typeUsageSummary(row({ ambiguous: true }), 'Status')).toBe(
      'used as member-access — branches on Status.Locked (value) — unverified identity (name-matched import)',
    );
  });

  it('marks an ambiguous type-position row too', () => {
    expect(
      typeUsageSummary(
        row({ usage: 'parameter', via: 'status', useKind: undefined, member: undefined, ambiguous: true }),
        'Status',
      ),
    ).toBe('used as parameter (status) — unverified identity (name-matched import)');
  });

  it('renders a verified row exactly as before', () => {
    expect(typeUsageSummary(row({}), 'Status')).toBe('used as member-access — branches on Status.Locked (value)');
    expect(
      typeUsageSummary(row({ usage: 'parameter', via: 'status', useKind: undefined, member: undefined }), 'Status'),
    ).toBe('used as parameter (status)');
  });

  it('names what a class consumer DOES rather than the slot it fills', () => {
    // "used as construction" would read as a type position, which is exactly what these are not.
    expect(
      typeUsageSummary(
        row({ name: 'build', usage: 'construction', member: undefined, useKind: TypeUseKind.Value }),
        'UserService',
      ),
    ).toBe('constructs UserService');
    expect(
      typeUsageSummary(row({ type: 'file', usage: 'import', member: undefined, useKind: undefined }), 'UserService'),
    ).toBe('imports UserService');
  });

  it('keeps the local alias of a renamed import and the unverified-identity suffix', () => {
    expect(
      typeUsageSummary(
        row({ type: 'file', usage: 'import', via: 'Svc', member: undefined, useKind: undefined }),
        'UserService',
      ),
    ).toBe('imports UserService (as Svc)');
    expect(typeUsageSummary(row({ usage: 'construction', member: undefined, ambiguous: true }), 'UserService')).toBe(
      'constructs UserService — unverified identity (name-matched import)',
    );
  });
});

describe('memberValueUsageNote', () => {
  it('names only verified members and flags that unverified rows are mixed in', () => {
    const note = memberValueUsageNote([row({}), row({ member: 'Open', ambiguous: true })], 'Status');
    expect(note).toBe(
      '2 of 2 usages are member-value reads (branches on Status.Locked) — unverified identity (name-matched import)',
    );
  });

  it('flags a note whose value rows are all unverified', () => {
    const note = memberValueUsageNote([row({ ambiguous: true })], 'Status');
    expect(note).toBe('1 of 1 usages are member-value reads — unverified identity (name-matched import)');
  });

  it('renders an all-verified note exactly as before', () => {
    expect(memberValueUsageNote([row({}), row({ member: 'Open' })], 'Status')).toBe(
      '2 of 2 usages are member-value reads (branches on Status.Locked, Status.Open)',
    );
  });
});
