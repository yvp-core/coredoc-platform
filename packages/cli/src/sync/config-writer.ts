/**
 * Update one project's cloud-facing fields in coredoc.config.json.
 *
 * Always re-reads from disk before each write so we don't clobber out-of-band
 * edits the user may have made mid-run. Merge semantics: undefined fields in
 * the patch leave the existing value alone; defined fields overwrite.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CloudSyncState, ProjectIntentCutover } from '@coredoc/core/types';

/**
 * Replace the config file ATOMICALLY: temp file in the same directory, then
 * rename over the original.
 *
 * `writeFileSync` truncates first and writes after, so a crash, a full disk or
 * a killed process between the two leaves a truncated or half-written
 * `coredoc.config.json` — the file that names every project, every repo and the
 * intent cutover marker. `rename(2)` within one directory is atomic, so a
 * reader sees either the whole old file or the whole new one.
 *
 * The mode of the existing file is preserved; the caller has always just read
 * it, so it exists.
 */
function replaceFileAtomically(filePath: string, contents: string): void {
  const { mode } = fs.statSync(filePath);
  // Same directory, so the rename never crosses a filesystem boundary.
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(temporary, contents, { mode });
    fs.renameSync(temporary, filePath);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

export function writeProjectCloud(configPath: string, projectId: string, patch: Partial<CloudSyncState>): void {
  const raw = fs.readFileSync(configPath, 'utf-8');
  const config = JSON.parse(raw) as { projects: Array<{ id: string; cloud?: CloudSyncState }> };

  const project = config.projects.find((p) => p.id === projectId);
  if (!project) {
    throw new Error(`Project '${projectId}' not found in ${configPath}`);
  }

  project.cloud = { ...(project.cloud ?? { enabled: false }), ...patch } as CloudSyncState;

  replaceFileAtomically(configPath, JSON.stringify(config, null, 2) + '\n');
}

/**
 * Write the product-intent cutover marker (spec §8.1) for one project.
 *
 * REPLACE, not merge: the marker is a single indivisible statement of who owns
 * authority, and merging half of one workspace's marker into another's is not a
 * state that should be representable. Writing it twice with the same value is a
 * no-op by construction, which is what lets the import command re-run its own
 * marker write after a crash without a "did I already do this" check.
 */
export function writeProjectIntent(configPath: string, projectId: string, intent: ProjectIntentCutover): void {
  const raw = fs.readFileSync(configPath, 'utf-8');
  const config = JSON.parse(raw) as { projects: Array<{ id: string; intent?: ProjectIntentCutover }> };

  const project = config.projects.find((p) => p.id === projectId);
  if (!project) {
    throw new Error(`Project '${projectId}' not found in ${configPath}`);
  }

  project.intent = { mode: intent.mode, workspaceId: intent.workspaceId };

  replaceFileAtomically(configPath, JSON.stringify(config, null, 2) + '\n');
}
