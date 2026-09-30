import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  CASE_IDS,
  parseLifecycleSelection,
  parseTargetManifest,
  parseTargetManifestText,
  selectRunnableCells,
} from './target-loader.js';

const SHA = '0123456789abcdef0123456789abcdef01234567';

function primaryContract(caseId: string) {
  return {
    admission: {
      artifact: { kind: 'issue', ref: `https://tracker.example/${caseId}` },
      observer: 'repository maintainer',
      decision: 'Decide whether this change is safe to ship.',
      verifierId: 'acme-api-v1',
    },
    truth: {
      required: [{ repoKey: 'sample', gitSha: SHA, file: 'source/file.ts', relation: caseId }],
      accepted: [],
      forbidden: [],
    },
  };
}

function manifest(): Record<string, unknown> {
  return {
    schemaVersion: 2,
    name: 'sample',
    path: 'sample-repo',
    baseBranch: 'main',
    repoKey: 'sample',
    gitSha: SHA,
    cells: Object.fromEntries(
      CASE_IDS.map((id) => [
        id,
        id === 'explain-repo'
          ? {
              lifecycle: 'smoke',
              provenance: {
                kind: 'source-audit',
                snapshotCommit: SHA,
                evidence: ['source/file.ts:1'],
              },
              params: {},
            }
          : {
              lifecycle: 'primary',
              ...primaryContract(id),
              provenance: {
                kind: 'source-audit',
                snapshotCommit: SHA,
                evidence: ['source/file.ts:1'],
              },
              params: { fixture: id },
            },
      ]),
    ),
  };
}

describe('target manifest schema v2', () => {
  it('does not let the host locale comparator change fallback manifest identity', () => {
    const raw = manifest();
    const baseline = parseTargetManifest(raw, '/manifests/sample.json').manifestHash;
    const compare = vi
      .spyOn(String.prototype, 'localeCompare')
      .mockImplementation(function (other) {
        return String(this) < String(other) ? 1 : String(this) > String(other) ? -1 : 0;
      });
    try {
      expect(parseTargetManifest(raw, '/manifests/sample.json').manifestHash).toBe(baseline);
    } finally {
      compare.mockRestore();
    }
  });

  it('requires exactly 20 explicit cells and selects primary by default', () => {
    const target = parseTargetManifest(manifest(), '/manifests/sample.json');
    expect(Object.keys(target.cells)).toHaveLength(20);
    expect(selectRunnableCells(target, parseLifecycleSelection(undefined))).toHaveLength(19);
    expect(selectRunnableCells(target, parseLifecycleSelection('primary,smoke'))).toHaveLength(20);
  });

  it('never selects quarantine, even when explicitly requested', () => {
    const raw = manifest();
    const cells = raw.cells as Record<string, unknown>;
    cells['explain-repo'] = {
      lifecycle: 'quarantine',
      reasonCode: 'truth-not-curated',
      reason: 'Ground truth has not been curated yet.',
    };
    const target = parseTargetManifest(raw, '/manifests/sample.json');
    expect(selectRunnableCells(target, new Set(['primary', 'smoke', 'diagnostic']))).toHaveLength(19);
    expect(() => parseLifecycleSelection('quarantine')).toThrow(/quarantine cannot be selected/);
  });

  it.each([
    ['legacy schema', () => ({ ...manifest(), schemaVersion: 1 })],
    ['missing cell', () => {
      const raw = manifest();
      delete (raw.cells as Record<string, unknown>)['impact-diff'];
      return raw;
    }],
    ['extra cell', () => {
      const raw = manifest();
      (raw.cells as Record<string, unknown>).surprise = {};
      return raw;
    }],
    ['magic TBD', () => {
      const raw = manifest();
      ((raw.cells as Record<string, any>)['blast-radius'].params as Record<string, unknown>).fixture = 'TBD';
      return raw;
    }],
    ['magic TBD in quarantine metadata', () => {
      const raw = manifest();
      (raw.cells as Record<string, unknown>)['explain-repo'] = {
        lifecycle: 'quarantine',
        reasonCode: 'truth-not-curated',
        reason: 'TBD',
      };
      return raw;
    }],
    ['empty runnable params', () => {
      const raw = manifest();
      (raw.cells as Record<string, any>)['blast-radius'].params = {};
      return raw;
    }],
    ['quarantine with params', () => {
      const raw = manifest();
      (raw.cells as Record<string, unknown>)['blast-radius'] = {
        lifecycle: 'quarantine',
        reasonCode: 'bad-truth',
        reason: 'Truth is invalid.',
        params: { fixture: true },
      };
      return raw;
    }],
  ])('rejects %s', (_label, build) => {
    expect(() => parseTargetManifest(build(), '/manifests/sample.json')).toThrow();
  });

  it('retains per-cell pinned sibling revisions', () => {
    const raw = manifest();
    (raw.cells as Record<string, any>)['impact-diff'].repoRevisions = {
      sibling: { gitSha: SHA, path: '../sibling' },
    };
    const target = parseTargetManifest(raw, '/manifests/sample.json');
    expect(target.cells['impact-diff'].repoRevisions?.sibling).toEqual({
      gitSha: SHA,
      path: '../sibling',
    });
  });

  it('binds a cell to a required access mode', () => {
    const raw = manifest();
    (raw.cells as Record<string, any>)['feature-implementation-plan'].requiresAccessMode =
      'historyless-snapshot';
    expect(
      parseTargetManifest(raw, '/manifests/sample.json').cells['feature-implementation-plan'],
    ).toMatchObject({ requiresAccessMode: 'historyless-snapshot' });
  });

  it('rejects an unknown required access mode with the enumerated modes', () => {
    const raw = manifest();
    (raw.cells as Record<string, any>)['feature-implementation-plan'].requiresAccessMode = 'sealed';
    expect(() => parseTargetManifest(raw, '/manifests/sample.json')).toThrow(
      /requiresAccessMode must be one of: worktree, no-checkout, historyless-snapshot\./,
    );
  });

  it('rejects a quarantine cell that pins a required access mode', () => {
    const raw = manifest();
    (raw.cells as Record<string, unknown>)['blast-radius'] = {
      lifecycle: 'quarantine',
      reasonCode: 'bad-truth',
      reason: 'Truth is invalid.',
      requiresAccessMode: 'historyless-snapshot',
    };
    expect(() => parseTargetManifest(raw, '/manifests/sample.json')).toThrow(
      /quarantine cells must not contain requiresAccessMode/,
    );
  });

  it('restricts provenance kinds to the governed set', () => {
    const raw = manifest();
    (raw.cells as Record<string, any>)['blast-radius'].provenance.kind = 'vibes';
    expect(() => parseTargetManifest(raw, '/manifests/sample.json')).toThrow(
      /source-audit.*counterfactual.*historical-diff/,
    );
  });

  it('rejects per-cell snapshot provenance that differs from the target gitSha', () => {
    const raw = manifest();
    (raw.cells as Record<string, any>)['blast-radius'].provenance.snapshotCommit =
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    expect(() => parseTargetManifest(raw, '/manifests/sample.json')).toThrow(
      /blast-radius.*snapshotCommit.*target gitSha/,
    );
  });

  it('fingerprints the exact manifest bytes, including whitespace', () => {
    const compact = JSON.stringify(manifest());
    const indented = JSON.stringify(manifest(), null, 2);
    expect(parseTargetManifestText(compact, '/m/a.json').manifestHash).not.toBe(
      parseTargetManifestText(indented, '/m/a.json').manifestHash,
    );
  });

  it('requires an external admission artifact and explicit structured truth for primary', () => {
    const noAdmission = manifest();
    delete (noAdmission.cells as Record<string, any>)['blast-radius'].admission;
    expect(() => parseTargetManifest(noAdmission, '/m/a.json')).toThrow(/admission/);

    const noTruth = manifest();
    delete (noTruth.cells as Record<string, any>)['blast-radius'].truth;
    expect(() => parseTargetManifest(noTruth, '/m/a.json')).toThrow(/truth/);

    const emptyRequired = manifest();
    (emptyRequired.cells as Record<string, any>)['blast-radius'].truth.required = [];
    expect(() => parseTargetManifest(emptyRequired, '/m/a.json')).toThrow(/truth\.required/);

    const noVerifier = manifest();
    delete (noVerifier.cells as Record<string, any>)['blast-radius'].admission.verifierId;
    expect(() => parseTargetManifest(noVerifier, '/m/a.json')).toThrow(/verifierId/);
  });

  it('requires source and artifact-base commit provenance for historical diffs', () => {
    const raw = manifest();
    const provenance = (raw.cells as Record<string, any>)['feature-implementation-plan']
      .provenance;
    provenance.kind = 'historical-diff';
    provenance.sourceCommit = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    provenance.artifactBaseCommit = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

    expect(
      parseTargetManifest(raw, '/m/a.json').cells['feature-implementation-plan'].provenance,
    ).toMatchObject({
      sourceCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      artifactBaseCommit: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    });

    delete provenance.artifactBaseCommit;
    expect(() => parseTargetManifest(raw, '/m/a.json')).toThrow(/artifactBaseCommit/);
    provenance.artifactBaseCommit = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    delete provenance.sourceCommit;
    expect(() => parseTargetManifest(raw, '/m/a.json')).toThrow(/sourceCommit/);
  });

  it('requires exact structured fact identity, a semantic discriminator, and no duplicates', () => {
    const noSemantic = manifest();
    (noSemantic.cells as Record<string, any>)['blast-radius'].truth.required = [
      { repoKey: 'sample', gitSha: SHA, file: 'source/file.ts' },
    ];
    expect(() => parseTargetManifest(noSemantic, '/m/a.json')).toThrow(/semantic discriminator/);

    const duplicate = manifest();
    const fact = (duplicate.cells as Record<string, any>)['blast-radius'].truth.required[0];
    (duplicate.cells as Record<string, any>)['blast-radius'].truth.accepted = [{ ...fact }];
    expect(() => parseTargetManifest(duplicate, '/m/a.json')).toThrow(/duplicate structured fact/);
  });

  it('binds structured facts to the target or a declared sibling pin SHA', () => {
    const wrongTargetSha = manifest();
    (wrongTargetSha.cells as Record<string, any>)['blast-radius'].truth.required[0].gitSha =
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    expect(() => parseTargetManifest(wrongTargetSha, '/m/a.json')).toThrow(/fact.*gitSha.*target/);

    const unpinnedSibling = manifest();
    (unpinnedSibling.cells as Record<string, any>)['blast-radius'].truth.required[0].repoKey =
      'sibling';
    expect(() => parseTargetManifest(unpinnedSibling, '/m/a.json')).toThrow(/sibling.*repoRevisions/);
  });
});
