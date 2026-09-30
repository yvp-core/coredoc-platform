/**
 * Linked Repos Manager
 *
 * Persists mappings of cloud workspace repos to local folder paths.
 * Storage: {userData}/linked-repos.json
 */

import { app, ipcMain } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { IpcChannels } from '../shared/ipc-types.js';
import type { LinkedRepo, LinkedRepoLinkResult } from '../shared/ipc-types.js';
import { selectFolders } from './dialog-manager.js';

interface LinkedReposData {
  repos: LinkedRepo[];
}

function getStoragePath(): string {
  return path.join(app.getPath('userData'), 'linked-repos.json');
}

function readStorage(): LinkedReposData {
  try {
    const data = fs.readFileSync(getStoragePath(), 'utf-8');
    return JSON.parse(data) as LinkedReposData;
  } catch {
    return { repos: [] };
  }
}

function writeStorage(data: LinkedReposData): void {
  fs.writeFileSync(getStoragePath(), JSON.stringify(data, null, 2), 'utf-8');
}

export function getLinkedRepos(workspaceId: string): LinkedRepo[] {
  const data = readStorage();
  return data.repos.filter((r) => r.workspaceId === workspaceId);
}

function setLinkedRepo(workspaceId: string, repoName: string, localPath: string): void {
  const data = readStorage();
  // Remove existing entry for this workspace+repo
  data.repos = data.repos.filter((r) => !(r.workspaceId === workspaceId && r.repoName === repoName));
  data.repos.push({ workspaceId, repoName, localPath });
  writeStorage(data);
}

export function removeLinkedRepo(workspaceId: string, repoName: string): void {
  const data = readStorage();
  data.repos = data.repos.filter((r) => !(r.workspaceId === workspaceId && r.repoName === repoName));
  writeStorage(data);
}

export function registerLinkedReposHandlers(): void {
  ipcMain.handle(IpcChannels.LINKED_REPOS_GET, (_event, workspaceId: string) => {
    return getLinkedRepos(workspaceId);
  });

  ipcMain.handle(IpcChannels.LINKED_REPOS_LINK, async (_event, workspaceId: string, repoName: string) => {
    const selection = await selectFolders();
    if (!selection.success) return { success: false, error: selection.error } satisfies LinkedRepoLinkResult;
    if (selection.canceled) return { success: true, canceled: true } satisfies LinkedRepoLinkResult;

    const localPath = selection.paths?.[0];
    if (!localPath)
      return { success: false, error: 'No repository folder was selected.' } satisfies LinkedRepoLinkResult;
    setLinkedRepo(workspaceId, repoName, localPath);
    return { success: true, canceled: false } satisfies LinkedRepoLinkResult;
  });

  ipcMain.handle(IpcChannels.LINKED_REPOS_REMOVE, (_event, workspaceId: string, repoName: string) => {
    removeLinkedRepo(workspaceId, repoName);
  });
}
