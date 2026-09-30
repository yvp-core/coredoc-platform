/**
 * Loads the fleet-managed configuration once, at process start.
 *
 * Side-effect module — MUST be imported before any manager module (mirrors
 * e2e-mode-boot / coredoc-home-boot) so that the very first `server-url.ts`
 * resolution, the telemetry init, and the update manager all see the same
 * pinned values. Reading it lazily instead would make the resolved server URL
 * depend on which subsystem happened to ask first.
 *
 * This file owns the only `electron` import of the managed-config pair, so
 * `managed-config.ts` stays testable without an Electron runtime.
 */
import { app } from 'electron';
import { initManagedConfig } from './managed-config.js';

initManagedConfig({ platform: process.platform, env: process.env, isPackaged: app.isPackaged });
