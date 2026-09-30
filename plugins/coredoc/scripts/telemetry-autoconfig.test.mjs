import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as autoconfig from './telemetry-autoconfig.mjs';

const UNAVAILABLE_MESSAGE =
  'Telemetry provisioning is unavailable in the legacy coredoc plugin. Use Coredoc Desktop managed-relay provisioning.';

test('legacy telemetry autoconfiguration is an inert unavailable result', () => {
  assert.equal(typeof autoconfig.telemetryAutoConfigurationStatus, 'function');
  assert.deepEqual(autoconfig.telemetryAutoConfigurationStatus(), {
    outcome: 'unavailable',
    message: UNAVAILABLE_MESSAGE,
  });
});

test('SessionStart preserves context while removing telemetry autoconfiguration', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8'),
  );
  const commands = manifest.hooks.SessionStart.flatMap((entry) => entry.hooks).map((hook) => hook.command);

  assert.deepEqual(commands, ['node "${CLAUDE_PLUGIN_ROOT}/scripts/session-context.mjs"']);
});
