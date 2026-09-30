import { describe, expect, it } from 'vitest';
import {
  assertRegisteredPrimary,
  getPrimaryRegistration,
  isRegisteredPrimaryVerifier,
} from './primary-registry.js';
import type { SelectedCell } from './target-loader.js';

const SHA = '0123456789abcdef0123456789abcdef01234567';

function selected(verifierId: string): SelectedCell {
  return {
    caseId: 'feature-implementation-plan',
    paramsKey: 'featureImplementationPlan',
    cell: {
      lifecycle: 'primary',
      admission: {
        artifact: { kind: 'issue', ref: 'ACME-1' },
        observer: 'An acme-api operator.',
        decision: 'Whether the change is safe to ship.',
        verifierId,
      },
      provenance: {
        kind: 'historical-diff',
        snapshotCommit: SHA,
        artifactBaseCommit: 'a'.repeat(40),
        sourceCommit: 'b'.repeat(40),
        evidence: ['test fixture'],
      },
      params: { feature: 'A feature prompt.' },
      truth: { required: [], accepted: [], forbidden: [] },
    },
  } as SelectedCell;
}

describe('primary registry admission', () => {
  it.each(['acme-api-v1', 'toString', '__proto__'])(
    'fails closed for the unregistered verifier %s',
    (verifierId) => {
      expect(isRegisteredPrimaryVerifier(verifierId)).toBe(false);
      expect(() => getPrimaryRegistration(verifierId)).toThrow(/unknown registered primary/i);
      expect(() =>
        assertRegisteredPrimary({ repoKey: 'acme-api', targetSha: SHA, selected: selected(verifierId) }),
      ).toThrow(/unknown registered primary/i);
    },
  );

  it('requires a primary lifecycle with an admission', () => {
    const cell = selected('acme-api-v1');
    delete cell.cell.admission;
    expect(() =>
      assertRegisteredPrimary({ repoKey: 'acme-api', targetSha: SHA, selected: cell }),
    ).toThrow(/registered primary admission is required/i);
  });
});
