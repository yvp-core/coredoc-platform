/**
 * Removes intermediate "unpacked" directories left by electron-builder.
 *
 * These directories (mac-arm64/, linux-unpacked/, win-unpacked/, etc.) contain
 * the full exploded app and can be 500 MB+. They're needed for smoke tests
 * (smoke:post) but should be removed before uploading CI artifacts.
 *
 * Usage:
 *   node ./scripts/clean-unpacked.mjs
 *
 * Searches dist-electron/ and its platform subdirectories (mac/, win/, linux/).
 */

import { existsSync, readdirSync, rmSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distElectron = path.resolve(__dirname, '..', 'dist-electron');

/** Patterns that match unpacked/intermediate directories (not final distributables). */
const UNPACKED_PATTERNS = [
  /^mac-arm64$/,
  /^mac-x64$/,
  /^mac-universal$/,
  /^linux-.*-unpacked$/,
  /^win-unpacked$/,
  /^win-ia32-unpacked$/,
  /^win-arm64-unpacked$/,
];

function isUnpackedDir(name) {
  return UNPACKED_PATTERNS.some((re) => re.test(name));
}

function cleanDir(searchDir) {
  if (!existsSync(searchDir)) return;

  for (const entry of readdirSync(searchDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (isUnpackedDir(entry.name)) {
      const full = path.join(searchDir, entry.name);
      console.log(`  Removing ${path.relative(distElectron, full)}/`);
      rmSync(full, { recursive: true, force: true });
    }
  }
}

if (!existsSync(distElectron)) {
  console.log('dist-electron/ not found — nothing to clean.');
  process.exit(0);
}

console.log('Cleaning unpacked directories from dist-electron/...\n');

// Clean top-level dist-electron/
cleanDir(distElectron);

// Clean platform subdirectories (dist-electron/mac/, dist-electron/win/, dist-electron/linux/)
for (const sub of ['mac', 'win', 'linux']) {
  cleanDir(path.join(distElectron, sub));
}

console.log('\nDone.');
