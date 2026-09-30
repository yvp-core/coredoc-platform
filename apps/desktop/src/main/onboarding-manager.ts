/**
 * Onboarding Manager
 *
 * Persists which (userId, workspaceId) pairs the user has already seen the
 * invited-user onboarding wizard for. Keyed by userId so multi-account
 * usage on one machine is safe.
 *
 * Storage: {userData}/onboarded-workspaces.json
 */

import { app, ipcMain } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { IpcChannels } from '../shared/ipc-types.js';
import { getProjectRoot } from './runtime-paths.js';

interface OnboardingEntry {
  userId: string;
  workspaceId: string;
  markedAt: string;
}

interface OnboardingData {
  entries: OnboardingEntry[];
}

// Mirrors `getDefaultConfigPath` in config-manager: prefer the workspace-scoped
// projectRoot so dev and prod use isolated files. Falls back to userData only
// if projectRoot is somehow uninitialized.
function getStoragePath(): string {
  const root = getProjectRoot();
  if (root) return path.join(root, 'onboarded-workspaces.json');
  return path.join(app.getPath('userData'), 'onboarded-workspaces.json');
}

function readStorage(): OnboardingData {
  try {
    const data = fs.readFileSync(getStoragePath(), 'utf-8');
    return JSON.parse(data) as OnboardingData;
  } catch {
    return { entries: [] };
  }
}

function writeStorage(data: OnboardingData): void {
  fs.writeFileSync(getStoragePath(), JSON.stringify(data, null, 2), 'utf-8');
}

export function listSeenWorkspaceIds(userId: string): string[] {
  const data = readStorage();
  return data.entries.filter((e) => e.userId === userId).map((e) => e.workspaceId);
}

export function markWorkspaceSeen(userId: string, workspaceId: string): void {
  const data = readStorage();
  const already = data.entries.some((e) => e.userId === userId && e.workspaceId === workspaceId);
  if (already) return;
  data.entries.push({ userId, workspaceId, markedAt: new Date().toISOString() });
  writeStorage(data);
}

export function registerOnboardingHandlers(): void {
  ipcMain.handle(IpcChannels.ONBOARDING_LIST_SEEN, (_event, userId: string) => {
    return listSeenWorkspaceIds(userId);
  });
  ipcMain.handle(IpcChannels.ONBOARDING_MARK_SEEN, (_event, userId: string, workspaceId: string) => {
    markWorkspaceSeen(userId, workspaceId);
  });
}
