import { describe, expect, it } from 'vitest';
import { matchesPath, scoreFilePaths } from '../harness/verifier.js';

describe('matchesPath', () => {
  it('exact match', () => {
    expect(matchesPath('a/b/c.ts', 'a/b/c.ts')).toBe(true);
  });

  it('case-insensitive', () => {
    expect(matchesPath('A/B/C.ts', 'a/b/c.ts')).toBe(true);
  });

  it('one is a whole-segment suffix of the other', () => {
    expect(matchesPath('src/foo/bar.ts', 'foo/bar.ts')).toBe(true);
    expect(matchesPath('foo/bar.ts', 'src/foo/bar.ts')).toBe(true);
  });

  it('tolerates a leading workspace/repo prefix segment', () => {
    // Real-world case: blast-radius' prompt asks for `repo-name/path`, and the
    // agent additionally prefixed the workspace directory name.
    expect(
      matchesPath(
        'acme/acme-packages/packages/acme-api-client/src/lib/booking/dto/enums.ts',
        'acme-packages/packages/acme-api-client/src/lib/booking/dto/enums.ts',
      ),
    ).toBe(true);
  });

  it('tolerates different monorepo prefixes', () => {
    expect(
      matchesPath(
        'src/modules/shifts/templates/templates.controller.ts',
        'services/api-gateway/src/modules/shifts/templates/templates.controller.ts',
      ),
    ).toBe(true);
  });

  it("ambiguous basename alone doesn't match across different parents", () => {
    expect(matchesPath('foo/index.ts', 'bar/index.ts')).toBe(false);
  });

  it('a bare basename matches nothing — the suffix must carry a directory', () => {
    expect(
      matchesPath(
        'templates.controller.ts',
        'services/api-gateway/src/modules/shifts/templates/templates.controller.ts',
      ),
    ).toBe(false);
  });

  it('suffix must align on a segment boundary', () => {
    // `.../my-enums.ts` ends with the truth string but not on a `/` boundary.
    expect(matchesPath('src/lib/my-enums.ts', 'lib/enums.ts')).toBe(false);
  });

  it('different files in same parent do not match', () => {
    expect(matchesPath('a/foo.ts', 'a/bar.ts')).toBe(false);
  });
});

describe('scoreFilePaths', () => {
  it('empty truth → zero score', () => {
    const r = scoreFilePaths(['anything.ts'], []);
    expect(r.recall).toBe(0);
    expect(r.f1).toBe(0);
  });

  it('full match across monorepo prefix divergence', () => {
    const cited = [
      'src/modules/shifts/templates/templates.controller.ts',
      'src/modules/shifts/templates/templates.service.ts',
    ];
    const truth = [
      'services/api-gateway/src/modules/shifts/templates/templates.controller.ts',
      'services/api-gateway/src/modules/shifts/templates/templates.service.ts',
    ];
    const r = scoreFilePaths(cited, truth);
    expect(r.recall).toBe(1);
    expect(r.precision).toBe(1);
    expect(r.matchedTruth.length).toBe(2);
  });

  it('partial recall with extra noise in cited', () => {
    // A UI file `services/templates.service.ts` does NOT collide with a gateway
    // file `templates/templates.service.ts` — they share a basename but no
    // whole-segment suffix. Two truths are present; only one is found.
    const r = scoreFilePaths(
      [
        'src/components/Shifts/api/services/templates.service.ts',
        'src/something/unrelated.ts',
      ],
      [
        'src/components/Shifts/api/services/templates.service.ts',
        'services/api-gateway/src/modules/shifts/templates/templates.service.ts',
      ],
    );
    expect(r.matchedTruth).toEqual([
      'src/components/Shifts/api/services/templates.service.ts',
    ]);
    expect(r.recall).toBe(0.5);
    expect(r.precision).toBeCloseTo(0.5, 5);
  });
});

describe('buildPrompt origin variants', () => {
  const target = { name: 'demo-admin' } as never;
  const base = { method: 'GET', path: '/v3/x/auth/validate', expectedRepos: ['a', 'b'] };

  it('default prompt keeps the trace-from-the-UI framing', async () => {
    const { crossRepoTraceCase } = await import('./cross-repo-trace.js');
    const prompt = crossRepoTraceCase.buildPrompt(target, base);
    expect(prompt).toContain('from the UI all the way');
    expect(prompt).not.toContain('Do not assume the origin');
  });

  it('originUnverified asks to establish the origin and admits a negative answer', async () => {
    // The authgate cell (2026-08-30): the default framing presupposed exactly the
    // reachability its forbidden tier bans; an honest answer either tripped the tier
    // by restating the premise or exhausted turns proving a negative.
    const { crossRepoTraceCase } = await import('./cross-repo-trace.js');
    const prompt = crossRepoTraceCase.buildPrompt(target, { ...base, originUnverified: true });
    expect(prompt).toContain('establish whether any code in this repo actually issues this call');
    expect(prompt).toContain('If nothing does, say so explicitly');
    expect(prompt).toContain('Do not assume the origin; verify it.');
    expect(prompt).not.toContain('from the UI all the way');
  });
});
