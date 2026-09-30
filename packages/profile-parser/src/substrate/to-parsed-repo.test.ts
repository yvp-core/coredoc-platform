import { describe, it, expect } from 'vitest';
import { toParsedRepo } from './to-parsed-repo.js';

const draft = {
  id: 'repo1',
  name: 'demo',
  path: '/tmp/demo',
  parsedAt: '2026-01-01T00:00:00.000Z',
  parserId: 'substrate',
  stats: { totalFiles: 0, parsedFiles: 0, skippedFiles: 0, totalImports: 0, parseTimeMs: 0 },
} as unknown as Parameters<typeof toParsedRepo>[0];

describe('toParsedRepo', () => {
  it('defaults every collection to [] and passes identity through', () => {
    const parsed = toParsedRepo(draft, { parserVersion: '1.2.0-go' });

    for (const key of [
      'packages',
      'files',
      'functions',
      'classes',
      'interfaces',
      'typeAliases',
      'enums',
      'variables',
      'entrypoints',
      'entities',
      'dbOperations',
      'calls',
      'imports',
      'externalCalls',
    ] as const) {
      expect(parsed[key], key).toEqual([]);
    }
    expect(parsed.id).toBe('repo1');
    expect(parsed.name).toBe('demo');
    expect(parsed.path).toBe('/tmp/demo');
    expect(parsed.parsedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(parsed.parserId).toBe('substrate');
    expect(parsed.stats).toMatchObject({ totalFiles: 0, parseTimeMs: 0 });
    expect(parsed.parserVersion).toBe('1.2.0-go');
  });

  // The counts are the draft's own collections, so a substrate cannot report a
  // total that its graph does not contain.
  it('derives the count fields from the collections it was given', () => {
    const parsed = toParsedRepo(
      {
        ...draft,
        functions: [{ id: 'f1' }, { id: 'f2' }],
        classes: [{ id: 'c1' }],
        entrypoints: [{ id: 'e1' }],
        entities: [{ id: 'n1' }],
        calls: [{ id: 'x1' }, { id: 'x2' }, { id: 'x3' }],
        externalCalls: [{ id: 'ec1' }],
      } as unknown as Parameters<typeof toParsedRepo>[0],
      { parserVersion: '1.2.0-go' },
    );

    expect(parsed.stats).toMatchObject({
      totalFunctions: 2,
      totalClasses: 1,
      totalEntrypoints: 1,
      totalEntities: 1,
      totalCalls: 3,
      totalExternalCalls: 1,
    });
  });

  it('omits `analysis` when the substrate reported none, and wraps the one it did', () => {
    expect('analysis' in toParsedRepo(draft, { parserVersion: '1.2.0-go' }).stats).toBe(false);

    const record = { language: 'go', mode: 'basic', compilerReceiverTypes: false, fallback: true } as const;
    const withAnalysis = toParsedRepo(
      { ...draft, stats: { ...draft.stats, analysis: record } } as unknown as Parameters<typeof toParsedRepo>[0],
      { parserVersion: '1.2.0-go' },
    );
    expect(withAnalysis.stats.analysis).toEqual([record]);
  });

  // `predatesMessagingSchema` in @coredoc/mcp reads any 1.0.x core as "parsed
  // before messaging descriptors" and permanently drops the repo's messaging
  // sites, so no substrate may stamp below 1.1.0. Re-asserted here (and not by
  // importing the MCP predicate) because profile-parser must not depend on mcp.
  it.each([
    '1.2.0-go',
    '1.2.0-python',
    '1.2.0-rust',
    '1.1.0-zig',
    '1.1.0-kotlin',
    '1.2.0-swift',
    '1.4.0-ruby',
  ])('substrate version %s is not pre-messaging', (version) => {
    const core = toParsedRepo(draft, { parserVersion: version }).parserVersion.split('-')[0]!;
    const [major, minor] = core.split('.').map(Number) as [number, number];
    expect(major > 1 || (major === 1 && minor >= 1)).toBe(true);
  });
});
