import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoId, resolveSession } from './ids.js';

describe('repoId', () => {
  it('is deterministic per (install, repoRoot) and differs across installs', () => {
    const a = repoId('install-1', '/x/y');
    expect(repoId('install-1', '/x/y')).toBe(a);
    expect(repoId('install-2', '/x/y')).not.toBe(a);
  });
});

describe('resolveSession', () => {
  it('prefers an explicit env session id (desktop passthrough)', async () => {
    expect(await resolveSession({ surface: 'cli', envSessionId: 'S-DESKTOP' })).toBe('S-DESKTOP');
  });
  it('reuses a fresh file session and mints a new one after TTL', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sess-'));
    const f = join(dir, 'session.json');
    const now = 1_000_000_000_000;
    const s1 = await resolveSession({ surface: 'cli', sessionFile: f, now });
    const s2 = await resolveSession({ surface: 'cli', sessionFile: f, now: now + 5 * 60_000 }); // within 30m
    expect(s2).toBe(s1);
    const s3 = await resolveSession({ surface: 'cli', sessionFile: f, now: now + 40 * 60_000 }); // past TTL
    expect(s3).not.toBe(s1);
    expect(JSON.parse(await readFile(f, 'utf8')).sessionId).toBe(s3);
  });
});
