/**
 * The work and state paths are identical in every turn and pod: Claude Code finds a session by its
 * working directory, and the plugin keys run state by absolute path. Home and temp are never archived.
 */
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

export interface TurnPaths {
  /** The agent's working directory. */
  work: string;
  /** Archived between turns: Claude Code's config directory and the plugin's state home. */
  state: string;
  claudeConfig: string;
  pluginStateHome: string;
  home: string;
  tmp: string;
}

export function turnPaths(scratchRoot: string, runId: string, turnId: string): TurnPaths {
  const state = join(scratchRoot, 'runs', runId, 'state');
  return {
    work: join(scratchRoot, 'runs', runId, 'work'),
    state,
    claudeConfig: join(state, 'claude'),
    pluginStateHome: join(state, 'coredoc-workflows'),
    home: join(scratchRoot, 'turns', turnId, 'home'),
    tmp: join(scratchRoot, 'turns', turnId, 'tmp'),
  };
}

export async function createTurnDirectories(paths: TurnPaths): Promise<void> {
  for (const dir of [paths.work, paths.claudeConfig, paths.pluginStateHome, paths.home, paths.tmp]) {
    await mkdir(dir, { recursive: true });
  }
}

export function sessionExists(paths: TurnPaths, sessionId: string): boolean {
  const projects = join(paths.claudeConfig, 'projects');
  if (!existsSync(projects)) return false;
  return readdirSync(projects, { withFileTypes: true }).some(
    (entry) => entry.isDirectory() && existsSync(join(projects, entry.name, `${sessionId}.jsonl`)),
  );
}

/** Between turns the whole scratch volume is wiped, so nothing a turn left behind reaches the next. */
export async function wipeScratch(scratchRoot: string): Promise<void> {
  if (!existsSync(scratchRoot)) return;
  for (const entry of await readdir(scratchRoot)) {
    await rm(join(scratchRoot, entry), { recursive: true, force: true });
  }
}
