/**
 * Dev-build isolation for the coredoc home directory (`~/.coredoc`).
 *
 * Side-effect module — MUST be imported before any manager module (mirrors
 * e2e-mode-boot) so every consumer, including the telemetry init and every
 * spawned worker/CLI that inherits process.env, sees the same COREDOC_HOME.
 *
 * Unpackaged (dev) runs default to `~/.coredoc-dev` so a dev desktop never
 * shares credentials, telemetry, session, or relay state with the packaged
 * app's `~/.coredoc`. An explicit COREDOC_HOME from the shell still wins
 * (`??=` semantics). E2E keeps its temp-HOME contract untouched: COREDOC_HOME
 * outranks HOME in resolveCoredocHome(), so setting it here would defeat the
 * e2e sandbox.
 */
import { app } from 'electron';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isE2EMode } from './e2e-mode.js';

if (!app.isPackaged && !isE2EMode(process.env) && !process.env.COREDOC_HOME?.trim()) {
  process.env.COREDOC_HOME = join(homedir(), '.coredoc-dev');
}
