import { describe, expect, it } from 'vitest';
// Barrel import registers the built-in ts/js + ruby providers (single wiring point).
import { isMultiTargetProfile, resolveProfileExport, resolveProfileModule, resolveTargets } from './index.js';
import type { MultiTargetProfile } from '../types/multi-profile.js';

const single = { parserId: 'p', substrate: { language: 'ts', include: [] } };

const multi: MultiTargetProfile = {
  parserId: 'acme',
  repoType: 'monorepo',
  targets: [
    { name: 'web', substrate: { language: 'ts', include: ['ui/**'] } },
    { name: 'api', substrate: { language: 'ruby', include: ['api/**'] } },
    { name: 'android', substrate: { language: 'kotlin', include: ['app/**'] } },
  ],
};

describe('isMultiTargetProfile', () => {
  it('accepts a composite (parserId + targets, no substrate)', () => {
    expect(isMultiTargetProfile(multi)).toBe(true);
  });
  it('rejects single profiles, junk, and substrate-bearing objects', () => {
    expect(isMultiTargetProfile(single)).toBe(false);
    expect(isMultiTargetProfile(null)).toBe(false);
    expect(isMultiTargetProfile({ parserId: 'p' })).toBe(false);
    expect(isMultiTargetProfile({ parserId: 'p', targets: [], substrate: { language: 'ts' } })).toBe(false);
  });
});

describe('resolveTargets', () => {
  it('resolves each target to its provider and stamps the composite parserId', () => {
    const targets = resolveTargets(multi);
    expect(targets.map((t) => t.provider.language)).toEqual(['ts', 'ruby', 'kotlin']);
    expect(targets.map((t) => t.profile.parserId)).toEqual(['acme', 'acme', 'acme']);
    expect(targets.map((t) => t.name)).toEqual(['web', 'api', 'android']);
  });
  it('throws on empty targets', () => {
    expect(() => resolveTargets({ parserId: 'p', targets: [] })).toThrow(/no targets/);
  });
  it('throws on a missing target name', () => {
    expect(() =>
      resolveTargets({ parserId: 'p', targets: [{ substrate: { language: 'ts', include: [] } } as never] }),
    ).toThrow(/missing a name/);
  });
  it('throws on duplicate target names', () => {
    expect(() =>
      resolveTargets({
        parserId: 'p',
        targets: [
          { name: 'a', substrate: { language: 'ts', include: [] } },
          { name: 'a', substrate: { language: 'ruby', include: [] } },
        ],
      }),
    ).toThrow(/Duplicate target name 'a'/);
  });
  it('throws when two targets use the same canonical provider', () => {
    expect(() =>
      resolveTargets({
        parserId: 'p',
        targets: [
          { name: 'web', substrate: { language: 'ts', include: ['apps/web/**'] } },
          { name: 'admin', substrate: { language: 'ts', include: ['apps/admin/**'] } },
        ],
      }),
    ).toThrow(/Targets 'web'.*'admin'.*same canonical 'ts' language provider.*one target per language provider/i);
  });
  it('treats provider aliases such as ts and js as the same canonical provider', () => {
    expect(() =>
      resolveTargets({
        parserId: 'p',
        targets: [
          { name: 'typed', substrate: { language: 'ts', include: ['src/**/*.ts'] } },
          { name: 'untyped', substrate: { language: 'js', include: ['scripts/**/*.js'] } },
        ],
      }),
    ).toThrow(/'typed' \(language 'ts'\).*'untyped' \(language 'js'\).*canonical 'ts'/i);
  });
  it('throws on an unregistered language, naming the target', () => {
    expect(() =>
      resolveTargets({
        parserId: 'p',
        targets: [{ name: 'svc', substrate: { language: 'cobol', include: [] } }] as never,
      }),
    ).toThrow(/Target 'svc'.*'cobol'/);
  });
});

describe('resolveProfileExport / resolveProfileModule', () => {
  it('dispatches a single profile through providerForExport', () => {
    const r = resolveProfileExport(single);
    expect(r?.kind).toBe('single');
    if (r?.kind === 'single') expect(r.provider.language).toBe('ts');
  });
  it('dispatches a composite to kind multi with resolved targets', () => {
    const r = resolveProfileExport(multi);
    expect(r?.kind).toBe('multi');
    if (r?.kind === 'multi') expect(r.targets).toHaveLength(3);
  });
  it('returns undefined for non-profiles', () => {
    expect(resolveProfileExport({})).toBeUndefined();
    expect(resolveProfileExport(null)).toBeUndefined();
  });
  it('scans a module record and finds the first dispatchable export', () => {
    const r = resolveProfileModule({ junk: 42, default: multi });
    expect(r?.kind).toBe('multi');
    expect(resolveProfileModule({ nothing: true })).toBeUndefined();
  });
});
