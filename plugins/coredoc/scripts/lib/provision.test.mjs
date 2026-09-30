import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { provisionTelemetry } from './provision.mjs';

const UNAVAILABLE_MESSAGE =
  'Telemetry provisioning is unavailable in the legacy coredoc plugin. Use Coredoc Desktop managed-relay provisioning.';

test('legacy provisioning is bounded unavailable without reading, minting, caching, or writing', async () => {
  const calls = [];
  const forbidden = (name) => async () => {
    calls.push(name);
    throw new Error(`${name} must not be called`);
  };

  const result = await provisionTelemetry({
    projectDir: '/synthetic/project',
    env: {},
    argv: [],
    deps: {
      readCreds: forbidden('readCreds'),
      writeCreds: forbidden('writeCreds'),
      fetchImpl: forbidden('fetchImpl'),
      writeTelemetryEnv: forbidden('writeTelemetryEnv'),
    },
  });

  assert.deepEqual(result, { outcome: 'unavailable', message: UNAVAILABLE_MESSAGE });
  assert.deepEqual(calls, []);
});

test('setup telemetry entrypoint imports no credential, mint, workspace, or settings writer', async () => {
  const source = await readFile(new URL('../setup-telemetry.mjs', import.meta.url), 'utf8');

  for (const forbiddenImport of ['./lib/creds.mjs', './lib/mint.mjs', './lib/workspace-resolve.mjs', './lib/settings-write.mjs']) {
    assert.doesNotMatch(source, new RegExp(forbiddenImport.replaceAll('.', '\\.')));
  }
  assert.doesNotMatch(source, /\bfetch\b/);
});

test('setup telemetry entrypoint returns the bounded unavailable outcome', () => {
  const entrypoint = fileURLToPath(new URL('../setup-telemetry.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [entrypoint], { encoding: 'utf8', env: {} });

  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.equal(
    result.stderr,
    `coredoc setup: ${UNAVAILABLE_MESSAGE}\n`,
  );
});

test('/coredoc:setup reports the managed-relay requirement without offering legacy telemetry writes', async () => {
  const source = await readFile(new URL('../../commands/setup.md', import.meta.url), 'utf8');

  assert.match(source, /Telemetry provisioning is unavailable in the legacy coredoc plugin/);
  assert.match(source, /Coredoc Desktop managed-relay provisioning/);
  assert.doesNotMatch(source, /COREDOC_TELEMETRY_TOKEN/);
  assert.doesNotMatch(source, /scripts\/setup-telemetry\.mjs/);
  assert.doesNotMatch(source, /scripts\/verify-telemetry\.mjs/);
});

test('legacy mint/cache/generic-env owner modules are no longer shipped', async () => {
  for (const relativePath of [
    './creds.mjs',
    './mint.mjs',
    './otel-env.mjs',
    './settings-write.mjs',
    './workspace-resolve.mjs',
    '../verify-telemetry.mjs',
  ]) {
    await assert.rejects(readFile(new URL(relativePath, import.meta.url), 'utf8'), { code: 'ENOENT' });
  }
});
