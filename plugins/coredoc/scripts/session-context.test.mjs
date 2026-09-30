import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repoKeyFromOrigin, telemetryTargetFromEnv } from './session-context.mjs';
test('repoKeyFromOrigin handles https, ssh scheme, and scp forms', () => {
  assert.equal(repoKeyFromOrigin('https://github.com/org/repo.git'), 'org/repo');
  assert.equal(repoKeyFromOrigin('git@github.com:group/sub/repo.git'), 'group/sub/repo');
  assert.equal(repoKeyFromOrigin('ssh://git@host:2222/org/repo.git'), 'org/repo');
  assert.equal(repoKeyFromOrigin(''), undefined);
});

test('session context uses the relay destination rather than the loopback exporter', () => {
  assert.deepEqual(telemetryTargetFromEnv({
    OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
    COREDOC_NATIVE_OTLP_FORWARD_ENDPOINT: 'https://api.example/api/v1/workspaces/ws_1/otel/v1/logs',
    OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer relay-token',
  }), {
    apiBase: 'https://api.example/api/v1',
    workspaceId: 'ws_1',
    token: 'relay-token',
  });
});

test('session context prefers the independent capture credential when available', () => {
  assert.deepEqual(telemetryTargetFromEnv({
    COREDOC_CAPTURE_ENDPOINT: 'https://api.example/api/v1/workspaces/ws_capture/capture/v1/events',
    COREDOC_CAPTURE_HEADERS: 'Authorization=Bearer capture-token',
    OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
  }), {
    apiBase: 'https://api.example/api/v1',
    workspaceId: 'ws_capture',
    token: 'capture-token',
  });
});

test('session context keeps the legacy direct-export settings as a rollback fallback', () => {
  assert.deepEqual(telemetryTargetFromEnv({
    OTEL_EXPORTER_OTLP_ENDPOINT: 'https://api.example/api/v1/workspaces/ws_legacy/otel',
    OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer legacy-token',
  }), {
    apiBase: 'https://api.example/api/v1',
    workspaceId: 'ws_legacy',
    token: 'legacy-token',
  });
});
