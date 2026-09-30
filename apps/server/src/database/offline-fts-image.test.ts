import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const dockerfile = readFileSync(resolve(SERVER_ROOT, 'Dockerfile'), 'utf8');
const provision = readFileSync(resolve(SERVER_ROOT, 'scripts/provision-ladybug-fts.mjs'), 'utf8');
const runtimeFts = readFileSync(resolve(SERVER_ROOT, 'scripts/offline-fts-smoke.mjs'), 'utf8');
const runtimeVerify = readFileSync(resolve(SERVER_ROOT, 'scripts/verify-ladybug-fts-offline.mjs'), 'utf8');
const containerTest = readFileSync(resolve(SERVER_ROOT, 'scripts/test-offline-fts-image.sh'), 'utf8');
const execFileAsync = promisify(execFile);

describe('server offline Ladybug FTS image contract', () => {
  it('uses glibc stages and makes image-time provisioning fatal', () => {
    // base, web-build, production — every stage that starts from a node image is glibc.
    expect(dockerfile.match(/^FROM node:22-bookworm-slim/gm)).toHaveLength(3);
    expect(dockerfile).not.toContain('node:22-alpine');
    expect(dockerfile).toContain('node apps/server/scripts/provision-ladybug-fts.mjs');
    expect(dockerfile).not.toMatch(/provision-ladybug-fts\.mjs[^\n]*\|\|\s*true/);
  });

  it('serves both extension-cache layouts from a fixed non-root-readable home', () => {
    expect(dockerfile).toContain('ENV HOME=/opt/ladybug');
    expect(dockerfile).not.toContain('ENV HOME=/root');
    expect(dockerfile).toContain('COPY --from=build /app/ladybug-home/ /opt/ladybug/');
    expect(dockerfile).not.toContain('COPY --from=build /app/ladybug-home/ /root/');
    expect(dockerfile).toContain('RUN chmod -R a+rX /opt/ladybug');
    expect(dockerfile).toContain('/root/.lbdb/extension');
    expect(dockerfile).toContain('/root/.lbug/extensions');
  });

  it('keeps INSTALL/bootstrap out of the copied runtime verifier', () => {
    expect(provision).toContain("ftsMode: 'bootstrap'");
    expect(runtimeFts).toContain('queryFtsIndex');
    expect(runtimeFts).not.toContain('LadybugDriver');
    expect(runtimeFts).not.toMatch(/\bINSTALL\s+FTS\b/i);
    expect(runtimeFts).not.toContain("ftsMode: 'bootstrap'");
    expect(runtimeVerify).toContain('openGraphFile');
    expect(runtimeVerify).toContain('queryOfflineFts(handle.repository)');
    expect(runtimeVerify).toContain('handleSearchSymbols');
    expect(dockerfile).not.toContain('COPY --from=build /app/apps/server/scripts/provision-ladybug-fts.mjs');
  });

  it('defines a fresh production-image test with networking and host caches disabled', () => {
    expect(containerTest).toContain('--no-cache');
    expect(containerTest).toContain('--target offline-fts-test');
    expect(dockerfile).toContain('FROM production AS offline-fts-test');
    expect(containerTest).toContain('--network none');
    expect(containerTest).toContain('--user 1000:1000');
    expect(containerTest).not.toMatch(/(?:^|\s)(?:-v|--volume)(?:\s|=)/m);
    expect(containerTest).toContain('verify-ladybug-fts-offline.mjs');
  });
});

describe.skipIf(process.env.DOCKER_E2E !== '1')('server offline Ladybug FTS image runtime', () => {
  it(
    'builds the production-derived image and queries FTS with networking disabled',
    async () => {
      const { stdout } = await execFileAsync('bash', [resolve(SERVER_ROOT, 'scripts/test-offline-fts-image.sh')], {
        cwd: resolve(SERVER_ROOT, '../..'),
        maxBuffer: 4 * 1024 * 1024,
        timeout: 15 * 60_000,
      });
      expect(stdout).toContain('{"offlineFts":true,"mcpRead":true');
      expect(stdout).toMatch(/sha256:[0-9a-f]{64}/);
    },
    15 * 60_000,
  );
});
