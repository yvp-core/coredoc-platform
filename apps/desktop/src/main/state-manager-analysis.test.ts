import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { parsedRepoFile } from '@coredoc/core/utils';

const workspace = vi.hoisted(() => ({ path: '' }));
vi.mock('electron', () => ({}));
vi.mock('@coredoc/cli/sdk', () => ({ getOpsTimestamps: async () => null }));
vi.mock('./config-manager.js', () => ({
  getCurrentConfig: () => ({ projects: [], output: { dir: 'output' }, parserStorage: 'parsers' }),
  getConfigDir: () => workspace.path,
  getCurrentConfigPath: () => join(workspace.path, 'coredoc.config.json'),
  resolveRepoPath: () => undefined,
}));
vi.mock('./review-manager.js', () => ({ getApprovalStatus: async () => undefined }));
vi.mock('./parser-artifact.js', () => ({
  resolveParserArtifactPath: () => undefined,
  profileArtifactPath: () => undefined,
}));
afterEach(() => rmSync(workspace.path, { recursive: true, force: true }));

it('carries the persisted analysis capabilities to desktop repo state', async () => {
  workspace.path = mkdtempSync(join(tmpdir(), 'coredoc-analysis-state-'));
  const path = parsedRepoFile(join(workspace.path, 'output'), 'project', 'api');
  mkdirSync(dirname(path), { recursive: true });
  const analysis = [{ language: 'csharp', mode: 'basic', compilerReceiverTypes: false, fallback: true }];
  writeFileSync(path, JSON.stringify({ files: [], stats: { analysis } }));
  const { getRepoDetailState } = await import('./state-manager.js');
  expect((await getRepoDetailState('project', 'api'))?.parsed.stats?.analysis).toEqual(analysis);
});
