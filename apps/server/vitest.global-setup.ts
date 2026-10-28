import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LadybugDriver } from '@coredoc/db/ladybug';

// Real-Ladybug suites load FTS from the home extension cache, as the server
// image does after provisioning it at build time. Install it once here so they
// do not depend on another package's tests having filled that cache first
// (turbo replays those from cache) or race a network install in a 10s hook.
export default async function provisionLadybugFts(): Promise<void> {
  const workDir = await mkdtemp(join(tmpdir(), 'coredoc-server-fts-'));
  const driver = new LadybugDriver(join(workDir, 'fts-bootstrap.graph'), {
    readOnly: false,
    ftsMode: 'bootstrap',
    initializeSchema: false,
  });
  try {
    await driver.initialize();
  } finally {
    await driver.close();
    await rm(workDir, { recursive: true, force: true });
  }
}
