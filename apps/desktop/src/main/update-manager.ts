/**
 * Update Manager - Handles auto-update lifecycle via electron-updater.
 *
 * Uses the GitHub Releases provider configured in package.json build.publish;
 * a managed config may swap in a generic mirror for closed networks.
 * Checks for updates on app launch and every 4 hours.
 * Downloads in background; user decides when to restart.
 */

import { type BrowserWindow, type IpcMain, app } from 'electron';
import { autoUpdater } from 'electron-updater';

import type { UpdateStatusInfo } from '../shared/ipc-types.js';
import { getManagedConfig } from './managed-config.js';

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

let mainWindow: BrowserWindow | null = null;
let currentStatus: UpdateStatusInfo = { status: 'idle' };
let checkTimer: ReturnType<typeof setInterval> | null = null;

function setStatus(status: UpdateStatusInfo): void {
  currentStatus = status;
  mainWindow?.webContents.send('update:status', status);
}

function setupAutoUpdater(): void {
  // Don't check for updates in dev mode
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  // A `-beta.N` build follows GitHub pre-releases (the beta channel); a stable
  // build only ever sees /releases/latest.
  autoUpdater.allowPrerelease = app.getVersion().includes('-');

  // Closed-network installs mirror the release feed. Only the managed config may
  // move it — an env var or renderer value here would let a local process serve
  // the app its own signed-by-nobody update.
  const managedFeedUrl = getManagedConfig().updateFeedUrl;
  if (managedFeedUrl) {
    autoUpdater.setFeedURL({ provider: 'generic', url: managedFeedUrl });
  }

  autoUpdater.on('checking-for-update', () => {
    setStatus({ status: 'checking' });
  });

  autoUpdater.on('update-available', (info) => {
    setStatus({ status: 'available', version: info.version });
    // Start downloading immediately
    autoUpdater.downloadUpdate();
  });

  autoUpdater.on('update-not-available', () => {
    setStatus({ status: 'idle' });
  });

  autoUpdater.on('download-progress', (progress) => {
    setStatus({
      status: 'downloading',
      version: currentStatus.version,
      downloadProgress: Math.round(progress.percent),
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    setStatus({ status: 'ready', version: info.version });
  });

  autoUpdater.on('error', (error) => {
    console.error('[Update] Error:', error.message);
    setStatus({ status: 'error', error: error.message });
    // Reset to idle after 30s so the UI doesn't stay in error state forever
    setTimeout(() => {
      if (currentStatus.status === 'error') {
        setStatus({ status: 'idle' });
      }
    }, 30_000);
  });

  // Initial check after a short delay (let the app settle)
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      console.error('[Update] Initial check failed:', err);
    });
  }, 5_000);

  // Periodic checks
  checkTimer = setInterval(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      console.error('[Update] Periodic check failed:', err);
    });
  }, CHECK_INTERVAL_MS);
}

export function registerUpdateHandlers(ipcMain: IpcMain, window: BrowserWindow): void {
  mainWindow = window;

  ipcMain.handle('update:check', async () => {
    if (!app.isPackaged) {
      return { updateAvailable: false };
    }
    try {
      // checkForUpdates() triggers events (update-available / update-not-available)
      // which update currentStatus via setStatus(). We await it to catch errors,
      // then return the current status which the events have already set.
      await autoUpdater.checkForUpdates();
      return {
        updateAvailable:
          currentStatus.status === 'available' ||
          currentStatus.status === 'downloading' ||
          currentStatus.status === 'ready',
        version: currentStatus.version,
      };
    } catch (error) {
      return { updateAvailable: false, error: error instanceof Error ? error.message : 'Check failed' };
    }
  });

  ipcMain.handle('update:install', () => {
    autoUpdater.quitAndInstall(false, true);
  });

  ipcMain.handle('update:getStatus', () => {
    return currentStatus;
  });

  ipcMain.handle('update:getAppVersion', () => {
    return app.getVersion();
  });

  setupAutoUpdater();
}

export function shutdownUpdateManager(): void {
  if (checkTimer) {
    clearInterval(checkTimer);
    checkTimer = null;
  }
}
