/** Workspace-scoped harness settings IPC. Raw credentials never cross into the renderer. */

import type { IpcMain } from 'electron';
import * as path from 'node:path';
import type { HarnessSettingsUpdate } from '../shared/ipc-types.js';
import { IpcChannels } from '../shared/ipc-types.js';
import { getEnvPath as runtimeGetEnvPath, requireProjectRoot } from './runtime-paths.js';
import { getHarnessSettingsStatus, updateHarnessSettings } from './harness-settings.js';

function getEnvPath(): string {
  return runtimeGetEnvPath() ?? path.join(requireProjectRoot(), '.env');
}

export function registerSettingsHandlers(ipcMain: IpcMain, resolveEnvPath: () => string = getEnvPath): void {
  ipcMain.handle(IpcChannels.SETTINGS_GET_HARNESS, () => getHarnessSettingsStatus(resolveEnvPath()));
  ipcMain.handle(IpcChannels.SETTINGS_UPDATE_HARNESS, (_event, update: HarnessSettingsUpdate) =>
    updateHarnessSettings(resolveEnvPath(), update),
  );
}
