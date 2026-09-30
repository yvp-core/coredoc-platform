/**
 * Session Manager - Handles chat session persistence
 */

import { IpcMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { getConfigDir } from './config-manager.js';
import {
  IpcChannels,
  ChatSession,
  ChatSessionMeta,
  SessionListResult,
  SessionLoadResult,
  SessionSaveResult,
  SessionDeleteResult,
  SessionRenameResult,
} from '../shared/ipc-types.js';

const SESSIONS_DIR = 'coredoc-sessions';

/**
 * Get the sessions directory path
 */
function getSessionsDir(): string | null {
  const configDir = getConfigDir();
  if (!configDir) return null;
  return path.join(configDir, SESSIONS_DIR);
}

/**
 * Ensure the project sessions directory exists
 */
function ensureProjectSessionsDir(projectId: string): string | null {
  const sessionsDir = getSessionsDir();
  if (!sessionsDir) return null;

  const projectDir = path.join(sessionsDir, projectId);
  if (!fs.existsSync(projectDir)) {
    fs.mkdirSync(projectDir, { recursive: true });
  }
  return projectDir;
}

/**
 * Find a session file by ID across all project directories
 */
function findSessionFile(sessionId: string): { filePath: string; projectId: string } | null {
  const sessionsDir = getSessionsDir();
  if (!sessionsDir || !fs.existsSync(sessionsDir)) return null;

  const projectDirs = fs
    .readdirSync(sessionsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  for (const projectId of projectDirs) {
    const filePath = path.join(sessionsDir, projectId, `${sessionId}.json`);
    if (fs.existsSync(filePath)) {
      return { filePath, projectId };
    }
  }
  return null;
}

/**
 * List all sessions for a project (metadata only)
 */
export function listSessions(projectId: string): SessionListResult {
  try {
    const sessionsDir = getSessionsDir();
    if (!sessionsDir) {
      return { success: false, error: 'No config loaded' };
    }

    const projectDir = path.join(sessionsDir, projectId);
    if (!fs.existsSync(projectDir)) {
      return { success: true, sessions: [] };
    }

    const files = fs.readdirSync(projectDir).filter((f) => f.endsWith('.json'));

    const sessions: ChatSessionMeta[] = [];
    for (const file of files) {
      try {
        const filePath = path.join(projectDir, file);
        const content = fs.readFileSync(filePath, 'utf-8');
        const session: ChatSession = JSON.parse(content);
        sessions.push({
          id: session.id,
          projectId: session.projectId,
          name: session.name,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          messageCount: session.messages?.length ?? 0,
        });
      } catch {
        // Skip invalid files
      }
    }

    // Sort by updatedAt descending (most recent first)
    sessions.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

    return { success: true, sessions };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error listing sessions',
    };
  }
}

/**
 * Load a session including all messages
 */
export function loadSession(sessionId: string): SessionLoadResult {
  try {
    const found = findSessionFile(sessionId);
    if (!found) {
      return { success: false, error: `Session not found: ${sessionId}` };
    }

    const content = fs.readFileSync(found.filePath, 'utf-8');
    const session: ChatSession = JSON.parse(content);

    return { success: true, session };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error loading session',
    };
  }
}

/**
 * Create a new session
 */
export function createSession(projectId: string, name?: string): SessionSaveResult {
  try {
    const projectDir = ensureProjectSessionsDir(projectId);
    if (!projectDir) {
      return { success: false, error: 'No config loaded' };
    }

    const now = new Date().toISOString();
    const session: ChatSession = {
      id: randomUUID(),
      projectId,
      name: name || `Chat ${new Date().toLocaleDateString()}`,
      createdAt: now,
      updatedAt: now,
      messages: [],
    };

    const filePath = path.join(projectDir, `${session.id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(session, null, 2), 'utf-8');

    return {
      success: true,
      session: {
        id: session.id,
        projectId: session.projectId,
        name: session.name,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        messageCount: 0,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error creating session',
    };
  }
}

/**
 * Save a session to disk
 */
export function saveSession(session: ChatSession): SessionSaveResult {
  try {
    const projectDir = ensureProjectSessionsDir(session.projectId);
    if (!projectDir) {
      return { success: false, error: 'No config loaded' };
    }

    // Update the timestamp
    session.updatedAt = new Date().toISOString();

    const filePath = path.join(projectDir, `${session.id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(session, null, 2), 'utf-8');

    return {
      success: true,
      session: {
        id: session.id,
        projectId: session.projectId,
        name: session.name,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        messageCount: session.messages?.length ?? 0,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error saving session',
    };
  }
}

/**
 * Delete a session
 */
export function deleteSession(sessionId: string): SessionDeleteResult {
  try {
    const found = findSessionFile(sessionId);
    if (!found) {
      return { success: false, error: `Session not found: ${sessionId}` };
    }

    fs.unlinkSync(found.filePath);
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error deleting session',
    };
  }
}

/**
 * Delete the entire sessions directory for a project. Used by deleteProject
 * in the renderer to hard-delete all chat history when a project is removed.
 *
 * Returns success:true if the directory was removed (or never existed).
 */
export function deleteProjectSessions(projectId: string): { success: boolean; error?: string } {
  try {
    const sessionsDir = getSessionsDir();
    if (!sessionsDir) {
      return { success: false, error: 'No config loaded' };
    }
    const projectDir = path.join(sessionsDir, projectId);
    if (fs.existsSync(projectDir)) {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Rename a session
 */
export function renameSession(sessionId: string, newName: string): SessionRenameResult {
  try {
    const found = findSessionFile(sessionId);
    if (!found) {
      return { success: false, error: `Session not found: ${sessionId}` };
    }

    const content = fs.readFileSync(found.filePath, 'utf-8');
    const session: ChatSession = JSON.parse(content);

    session.name = newName;
    session.updatedAt = new Date().toISOString();

    fs.writeFileSync(found.filePath, JSON.stringify(session, null, 2), 'utf-8');

    return {
      success: true,
      session: {
        id: session.id,
        projectId: session.projectId,
        name: session.name,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        messageCount: session.messages?.length ?? 0,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error renaming session',
    };
  }
}

/**
 * Register IPC handlers for session operations
 */
export function registerSessionHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IpcChannels.SESSION_LIST, (_event, projectId: string) => {
    return listSessions(projectId);
  });

  ipcMain.handle(IpcChannels.SESSION_LOAD, (_event, sessionId: string) => {
    return loadSession(sessionId);
  });

  ipcMain.handle(IpcChannels.SESSION_CREATE, (_event, projectId: string, name?: string) => {
    return createSession(projectId, name);
  });

  ipcMain.handle(IpcChannels.SESSION_SAVE, (_event, session: ChatSession) => {
    return saveSession(session);
  });

  ipcMain.handle(IpcChannels.SESSION_DELETE, (_event, sessionId: string) => {
    return deleteSession(sessionId);
  });

  ipcMain.handle(IpcChannels.SESSION_RENAME, (_event, sessionId: string, newName: string) => {
    return renameSession(sessionId, newName);
  });

  ipcMain.handle(IpcChannels.SESSION_DELETE_PROJECT, (_event, projectId: string) => {
    return deleteProjectSessions(projectId);
  });
}
