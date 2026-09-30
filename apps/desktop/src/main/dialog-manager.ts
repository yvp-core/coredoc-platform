/**
 * Dialog Manager - Handles native Electron dialogs
 */

import { dialog, IpcMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import {
  IpcChannels,
  DialogSelectFoldersResult,
  DialogSelectTemplateDagResult,
  DialogSelectTemplateFileResult,
} from '../shared/ipc-types.js';

/**
 * Open native folder selection dialog
 */
export async function selectFolders(): Promise<DialogSelectFoldersResult> {
  try {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'multiSelections'],
      title: 'Select Repository Folders',
    });

    if (result.canceled) {
      return {
        success: true,
        canceled: true,
        paths: [],
      };
    }

    return {
      success: true,
      canceled: false,
      paths: result.filePaths,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error selecting folders',
    };
  }
}

/**
 * Open native dialog to select a prompt DAG file or template pack directory.
 */
export async function selectTemplateDag(): Promise<DialogSelectTemplateDagResult> {
  try {
    const result = await dialog.showOpenDialog({
      properties: ['openFile', 'openDirectory'],
      title: 'Select Prompt Template DAG',
      filters: [{ name: 'JSON Files', extensions: ['json'] }],
    });

    if (result.canceled) {
      return {
        success: true,
        canceled: true,
      };
    }

    const selected = result.filePaths[0];
    if (!selected) {
      return {
        success: false,
        error: 'No file or directory was selected',
      };
    }

    const stat = fs.statSync(selected);
    const resolvedPath = stat.isDirectory() ? path.join(selected, 'prompts-dag.json') : selected;

    if (!fs.existsSync(resolvedPath)) {
      return {
        success: false,
        error: `Template DAG not found at: ${resolvedPath}`,
      };
    }

    return {
      success: true,
      canceled: false,
      path: resolvedPath,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error selecting template DAG',
    };
  }
}

/**
 * Open native dialog to select a single markdown template file.
 */
export async function selectTemplateFile(): Promise<DialogSelectTemplateFileResult> {
  try {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      title: 'Select Template File',
      filters: [{ name: 'Markdown Files', extensions: ['md', 'markdown'] }],
    });

    if (result.canceled) {
      return {
        success: true,
        canceled: true,
      };
    }

    const selected = result.filePaths[0];
    if (!selected) {
      return {
        success: false,
        error: 'No template file was selected',
      };
    }

    return {
      success: true,
      canceled: false,
      path: selected,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error selecting template file',
    };
  }
}

/**
 * Register IPC handlers for dialog operations
 */
export function registerDialogHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IpcChannels.DIALOG_SELECT_FOLDERS, async () => {
    return selectFolders();
  });

  ipcMain.handle(IpcChannels.DIALOG_SELECT_TEMPLATE_DAG, async () => {
    return selectTemplateDag();
  });

  ipcMain.handle(IpcChannels.DIALOG_SELECT_TEMPLATE_FILE, async () => {
    return selectTemplateFile();
  });
}
