import * as fs from 'fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const workspace = vi.hoisted(() => ({ path: '' }));
const getOpsTimestamps = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({}));
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync), createReadStream: vi.fn(actual.createReadStream) };
});
vi.mock('@coredoc/cli/sdk', () => ({ getOpsTimestamps }));
vi.mock('./config-manager.js', () => ({
  getCurrentConfig: () => ({ output: { dir: 'output' }, parserStorage: 'parsers' }),
  getConfigDir: () => workspace.path,
  getCurrentConfigPath: () => join(workspace.path, 'coredoc.config.json'),
  resolveRepoPath: () => undefined,
}));

beforeEach(() => {
  workspace.path = fs.mkdtempSync(join(tmpdir(), 'coredoc-status-'));
  fs.mkdirSync(join(workspace.path, 'output', 'project'), { recursive: true });
  fs.mkdirSync(join(workspace.path, 'parsers', 'project', 'api'), { recursive: true });
  getOpsTimestamps.mockResolvedValue({ lastPushed: '2026-09-20T10:00:00Z' });
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(workspace.path, { recursive: true, force: true });
});

describe('repository list status', () => {
  it('reads approval and operations without opening parsed output or summaries', async () => {
    const profile = 'export default {};';
    const parserDir = join(workspace.path, 'parsers', 'project', 'api');
    fs.writeFileSync(join(parserDir, 'profile.ts'), profile);
    fs.writeFileSync(
      join(parserDir, 'metadata.json'),
      JSON.stringify({
        approval: { approvedParserHash: createHash('sha256').update(profile).digest('hex') },
      }),
    );
    const parsed = join(workspace.path, 'output', 'project', 'api.json');
    const summaries = join(workspace.path, 'output', 'project', 'api-summaries.json');
    fs.writeFileSync(parsed, '{}');
    fs.writeFileSync(summaries, '{}');
    const read = vi.spyOn(fs, 'readFileSync');
    const stream = vi.spyOn(fs, 'createReadStream');

    const { getRepoStatusState } = await import('./state-manager.js');
    const state = await getRepoStatusState('project', 'api');
    expect(state).toMatchObject({
      parserExists: true,
      parsed: { exists: true },
      summarized: { exists: true },
      neo4jSynced: { synced: true },
      approval: { approved: true, isStale: false },
    });
    expect(state?.approval).not.toHaveProperty('outputMatchesParser');
    expect(getOpsTimestamps).toHaveBeenCalledWith('project', 'api', workspace.path);
    for (const file of [parsed, summaries]) {
      expect(read.mock.calls.some(([p]) => p === file)).toBe(false);
      expect(stream.mock.calls.some(([p]) => p === file)).toBe(false);
    }

    fs.writeFileSync(join(parserDir, 'profile.ts'), 'export default { changed: true };');
    expect((await getRepoStatusState('project', 'api'))?.approval?.isStale).toBe(true);
  });

  it('does not turn an old operation into an existing parse or approval', async () => {
    const { getRepoStatusState } = await import('./state-manager.js');
    expect(await getRepoStatusState('project', 'api')).toMatchObject({
      parserExists: false,
      parsed: { exists: false },
      summarized: { exists: false },
    });
    expect((await getRepoStatusState('project', 'api'))?.approval).toBeUndefined();
  });

  it('still verifies the actual output when opening the full approval check', async () => {
    const parserDir = join(workspace.path, 'parsers', 'project', 'api');
    const profile = 'export default {};';
    const hash = createHash('sha256').update(profile).digest('hex');
    fs.writeFileSync(join(parserDir, 'profile.ts'), profile);
    fs.writeFileSync(join(parserDir, 'metadata.json'), JSON.stringify({ approval: { approvedParserHash: hash } }));
    const parsed = join(workspace.path, 'output', 'project', 'api.json');
    fs.writeFileSync(parsed, JSON.stringify({ parserHashAtParse: 'different' }));
    const { getApprovalStatus } = await import('./review-manager.js');
    expect(await getApprovalStatus('project', 'api')).toMatchObject({ approved: true, outputMatchesParser: false });
    fs.writeFileSync(parsed, JSON.stringify({ parserHashAtParse: hash }));
    expect(await getApprovalStatus('project', 'api')).toMatchObject({ approved: true, outputMatchesParser: true });
  });
});
