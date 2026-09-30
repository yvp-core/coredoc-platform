import { expect, test } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { git, seedMemberProvisioningRepo } from './fixtures/git-fixtures.js';

test('member provisioning seed uses one real Git origin and one exact linked temp path', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'coredoc-member-repo-'));
  const launchProfile = {
    workspaceDir: path.join(root, 'workspace'),
    userDataDir: path.join(root, 'user-data'),
  };
  const repoPath = path.join(launchProfile.workspaceDir, 'repos', 'demo-api');
  mkdirSync(repoPath, { recursive: true });
  mkdirSync(launchProfile.userDataDir, { recursive: true });

  try {
    seedMemberProvisioningRepo(launchProfile);

    expect(git(repoPath, ['remote', 'get-url', 'origin'])).toBe('https://github.com/demo/demo-api.git');
    expect(JSON.parse(readFileSync(path.join(launchProfile.userDataDir, 'linked-repos.json'), 'utf8'))).toEqual({
      repos: [{ workspaceId: 'ws_e2e_demo', repoName: 'demo-api', localPath: repoPath }],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
