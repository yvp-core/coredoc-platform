import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getPath: vi.fn(),
  handle: vi.fn(),
  selectFolders: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { getPath: mocks.getPath },
  ipcMain: { handle: mocks.handle },
}));
vi.mock('./dialog-manager.js', () => ({ selectFolders: mocks.selectFolders }));

import { getLinkedRepos, registerLinkedReposHandlers } from './linked-repos-manager';

describe('linked repo IPC', () => {
  let storageDir: string;
  let handlers: Map<string, (...args: unknown[]) => unknown>;

  beforeEach(() => {
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coredoc-linked-repos-'));
    handlers = new Map();
    mocks.getPath.mockReturnValue(storageDir);
    mocks.handle.mockReset();
    mocks.handle.mockImplementation((channel, handler) => handlers.set(channel, handler));
    mocks.selectFolders.mockReset();
  });

  afterEach(() => {
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  it('persists only the path returned by the main-process folder picker', async () => {
    mocks.selectFolders.mockResolvedValue({ success: true, canceled: false, paths: ['/trusted/repo'] });
    registerLinkedReposHandlers();

    expect(handlers.has('linkedRepos:set')).toBe(false);
    const linkRepo = handlers.get('linkedRepos:link');
    expect(linkRepo).toBeDefined();

    await linkRepo?.({}, 'workspace-1', 'repo-1', '/renderer-controlled');

    expect(mocks.selectFolders).toHaveBeenCalledOnce();
    expect(getLinkedRepos('workspace-1')).toEqual([
      { workspaceId: 'workspace-1', repoName: 'repo-1', localPath: '/trusted/repo' },
    ]);
  });

  it('does not persist a link when native folder selection is cancelled', async () => {
    mocks.selectFolders.mockResolvedValue({ success: true, canceled: true, paths: [] });
    registerLinkedReposHandlers();

    const result = await handlers.get('linkedRepos:link')?.({}, 'workspace-1', 'repo-1');

    expect(result).toEqual({ success: true, canceled: true });
    expect(getLinkedRepos('workspace-1')).toEqual([]);
  });
});
