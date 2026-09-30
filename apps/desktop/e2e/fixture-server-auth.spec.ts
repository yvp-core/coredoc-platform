import { expect, test } from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startFixtureServer } from './fixtures/fixture-server.js';

test('authenticated fixture routes record only bounded authorization facts', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'coredoc-fixture-auth-'));
  const profileDir = path.join(root, 'profile');
  mkdirSync(profileDir);
  writeFileSync(
    path.join(profileDir, 'auth.json'),
    JSON.stringify({ accessToken: 'fixture-access-token-must-not-be-recorded' }),
    'utf8',
  );

  const server = await startFixtureServer({ 'GET /api/v1/workspaces': [] }, profileDir);
  try {
    const accepted = await fetch(`${server.origin}/api/v1/workspaces`, {
      headers: { Authorization: 'Bearer fixture-access-token-must-not-be-recorded' },
    });
    const rejected = await fetch(`${server.origin}/api/v1/workspaces`, {
      headers: { Authorization: 'Bearer wrong-token-must-not-be-recorded' },
    });

    expect(accepted.status).toBe(200);
    expect(rejected.status).toBe(401);
    expect(server.requests).toEqual([
      {
        method: 'GET',
        path: '/api/v1/workspaces',
        status: 200,
        matched: true,
        auth: 'accepted',
      },
      {
        method: 'GET',
        path: '/api/v1/workspaces',
        status: 401,
        matched: true,
        auth: 'rejected',
      },
    ]);
    expect(/fixture-access-token|wrong-token|authorization/i.test(JSON.stringify(server.requests))).toBe(false);
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
