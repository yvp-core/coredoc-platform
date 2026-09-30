/**
 * PTY Manager - Manages pseudo-terminal lifecycle using node-pty
 *
 * node-pty is a native CJS addon. We load it lazily to avoid crashing the
 * main bundle if the module isn't available (e.g. packaged app path issues).
 * createRequire() is used because the esbuild CJS bundle's built-in require
 * may not resolve externals the same way.
 */

import { createRequire } from 'module';
import { BrowserWindow } from 'electron';
import { IpcChannels, CommandCompleted } from '../shared/ipc-types.js';

// Lazy-load node-pty: defer until first use to avoid crashing the bundle at module level.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _pty: any = null;
function getPty() {
  if (!_pty) {
    const _require = createRequire(import.meta.url);
    _pty = _require('@lydell/node-pty');
  }
  return _pty;
}

interface PtyInstance {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  process: any; // node-pty IPty instance (lazy-loaded, can't reference type statically)
  id: string;
}

const runningPtys = new Map<string, PtyInstance>();

export interface SpawnPtyOptions {
  id: string;
  file: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Optional main-process callback fired when the PTY exits (e.g. metadata cleanup). */
  onExit?: (exitCode: number) => void;
}

export function buildPtyEnvironment(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // A caller-supplied environment may have intentionally removed credentials; merging process.env would restore them.
  return {
    ...(env ?? process.env),
    TERM: 'xterm-256color',
  };
}

/**
 * Spawn a new PTY process and wire up IPC forwarding.
 */
export function spawnPty(options: SpawnPtyOptions, mainWindow: BrowserWindow): void {
  const { id, file, args, cwd, env, onExit } = options;

  const pty = getPty();
  const ptyProcess = pty.spawn(file, args, {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd,
    env: buildPtyEnvironment(env),
  });

  const instance: PtyInstance = { process: ptyProcess, id };
  runningPtys.set(id, instance);

  // Forward PTY data to renderer
  ptyProcess.onData((data: string) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IpcChannels.PTY_DATA, { id, data });
    }
  });

  // Handle PTY exit
  ptyProcess.onExit(({ exitCode, signal }: { exitCode: number; signal?: number }) => {
    runningPtys.delete(id);
    onExit?.(exitCode ?? -1);

    if (!mainWindow.isDestroyed()) {
      // Send PTY_EXIT for the XTerminal component
      mainWindow.webContents.send(IpcChannels.PTY_EXIT, { id, exitCode, signal });

      // Send COMMAND_COMPLETED so the store's generate→parse chaining works unchanged
      const result: CommandCompleted = {
        id,
        success: exitCode === 0,
        exitCode: exitCode ?? -1,
      };
      mainWindow.webContents.send(IpcChannels.COMMAND_COMPLETED, result);
    }

    console.log(`[PTY ${id}] Exited with code ${exitCode}, signal ${signal}`);
  });

  console.log(`[PTY ${id}] Spawned: ${file} ${args.join(' ')}`);
}

/**
 * Write data (user keyboard input) to a PTY's stdin.
 */
export function writePty(id: string, data: string): boolean {
  const instance = runningPtys.get(id);
  if (instance) {
    instance.process.write(data);
    return true;
  }
  return false;
}

/**
 * Resize a PTY.
 */
export function resizePty(id: string, cols: number, rows: number): boolean {
  const instance = runningPtys.get(id);
  if (instance) {
    instance.process.resize(cols, rows);
    return true;
  }
  return false;
}

/**
 * Kill a PTY and its entire process group.
 */
export function killPty(id: string): boolean {
  const instance = runningPtys.get(id);
  if (instance) {
    // node-pty's kill() sends signal to the process group, solving orphaned child processes
    instance.process.kill();

    // Force kill after 5 seconds if still running
    setTimeout(() => {
      if (runningPtys.has(id)) {
        try {
          instance.process.kill('SIGKILL');
        } catch {
          // Already dead
        }
        runningPtys.delete(id);
      }
    }, 5000);

    return true;
  }
  return false;
}

/**
 * Kill all running PTYs (cleanup on app quit).
 */
export function killAllPtys(): void {
  for (const [id, instance] of runningPtys) {
    try {
      instance.process.kill();
    } catch {
      // Ignore
    }
    runningPtys.delete(id);
  }
}

/**
 * Check if a PTY is still running.
 */
export function hasPty(id: string): boolean {
  return runningPtys.has(id);
}
