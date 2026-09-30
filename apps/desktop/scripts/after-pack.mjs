/**
 * electron-builder afterPack hook.
 *
 * Renames `dist/runtime/_vendor` → `dist/runtime/node_modules` inside the
 * ASAR-unpacked directory. This is necessary because:
 *
 *   1. electron-builder prunes any directory named `node_modules` during packaging,
 *      removing packages it doesn't see in the desktop app's own dependency tree.
 *   2. Node's ESM resolver only walks up looking for `node_modules/` — it ignores
 *      NODE_PATH and won't find packages in a differently-named directory.
 *
 * By building with `_vendor` (so electron-builder doesn't touch it) and renaming
 * to `node_modules` after packing, we get the best of both worlds.
 */

import { renameSync, existsSync } from 'fs';
import path from 'path';

export default async function afterPack(context) {
  const { appOutDir, electronPlatformName, packager } = context;

  let resourcesDir;
  if (electronPlatformName === 'darwin') {
    const appName = packager.appInfo.productFilename;
    resourcesDir = path.join(appOutDir, `${appName}.app`, 'Contents', 'Resources');
  } else {
    resourcesDir = path.join(appOutDir, 'resources');
  }

  const unpackedRuntime = path.join(resourcesDir, 'app.asar.unpacked', 'dist', 'runtime');
  const vendorDir = path.join(unpackedRuntime, '_vendor');
  const nodeModulesDir = path.join(unpackedRuntime, 'node_modules');

  if (existsSync(vendorDir)) {
    renameSync(vendorDir, nodeModulesDir);
    console.log(`  • afterPack: renamed _vendor → node_modules in ${unpackedRuntime}`);
  } else {
    console.warn(`  • afterPack: _vendor not found at ${vendorDir}, skipping rename`);
  }
}
