import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ParsedRepo } from '@coredoc/core/types';

const loadParser = vi.fn();
vi.mock('./parser-loader.js', () => ({ loadParser: (...args: unknown[]) => loadParser(...args) }));

const { parseRepoArtifact } = await import('./parse-repo.js');

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'parse-repo-'));
  loadParser.mockReset();
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** Degraded TS target with no resolved call or external-call edge at all. */
function blackoutRepo(): ParsedRepo {
  return {
    id: 'r',
    name: 'demo',
    path: tmp,
    parsedAt: '2026-01-01T00:00:00.000Z',
    parserId: 'p',
    parserVersion: '1.1.0',
    packages: [],
    files: [{ id: 'f1', path: 'src/a.ts', target: 'web' }],
    functions: [{ id: 'fn1', fileId: 'f1' }],
    classes: [],
    interfaces: [],
    typeAliases: [],
    enums: [],
    variables: [],
    entrypoints: [],
    entities: [],
    dbOperations: [],
    calls: [],
    imports: [],
    externalCalls: [],
    stats: {
      analysis: [{ language: 'ts', target: 'web', mode: 'basic', compilerReceiverTypes: false, fallback: true }],
    },
  } as unknown as ParsedRepo;
}

function mockParser(parsed: ParsedRepo) {
  loadParser.mockResolvedValue({ parse: async () => parsed });
}

describe('parseRepoArtifact — semantic blackout', () => {
  it('throws when refuseSemanticBlackout is set and no edge resolved', async () => {
    mockParser(blackoutRepo());
    await expect(
      parseRepoArtifact({
        parserStorage: tmp,
        projectId: 'alpha',
        repoName: 'demo',
        repoRoot: tmp,
        refuseSemanticBlackout: true,
        warn: vi.fn(),
      }),
    ).rejects.toThrow(/semantic analysis was unavailable/);
  });

  it('resolves the degraded graph when refuseSemanticBlackout is false', async () => {
    mockParser(blackoutRepo());
    const warn = vi.fn();
    const result = await parseRepoArtifact({
      parserStorage: tmp,
      projectId: 'alpha',
      repoName: 'demo',
      repoRoot: tmp,
      refuseSemanticBlackout: false,
      warn,
    });
    expect(result.name).toBe('demo');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('basic analysis'));
  });
});

describe('parseRepoArtifact — parser-artifact hash', () => {
  function artifactDir(): string {
    const dir = join(tmp, 'alpha', 'demo');
    mkdirSync(dir, { recursive: true });
    return dir;
  }
  const sha = (text: string) => createHash('sha256').update(Buffer.from(text)).digest('hex');

  it('prefers profile.ts when both artifacts exist', async () => {
    const dir = artifactDir();
    writeFileSync(join(dir, 'profile.ts'), 'profile', 'utf-8');
    writeFileSync(join(dir, 'parser.ts'), 'parser', 'utf-8');
    mockParser({ ...blackoutRepo(), stats: {} } as unknown as ParsedRepo);

    const result = await parseRepoArtifact({ parserStorage: tmp, projectId: 'alpha', repoName: 'demo', repoRoot: tmp });
    expect(result.parserHashAtParse).toBe(sha('profile'));
  });

  it('hashes parser.ts when only the legacy artifact exists', async () => {
    const dir = artifactDir();
    writeFileSync(join(dir, 'parser.ts'), 'parser', 'utf-8');
    mockParser({ ...blackoutRepo(), stats: {} } as unknown as ParsedRepo);

    const result = await parseRepoArtifact({ parserStorage: tmp, projectId: 'alpha', repoName: 'demo', repoRoot: tmp });
    expect(result.parserHashAtParse).toBe(sha('parser'));
  });
});
