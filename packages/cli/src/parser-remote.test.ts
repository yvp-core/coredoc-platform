import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createParserArchive, pushParserToServer } from './parser-remote.js';

vi.mock('./auth.js', () => ({
  getToken: vi.fn(async () => 'cdt_test'),
  getServerUrl: vi.fn(async () => 'https://api.test'),
  authHeaders: vi.fn(async () => ({ Authorization: 'Bearer cdt_test' })),
}));

describe('parser-remote', () => {
  let tempDir: string;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'parser-remote-'));
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates deterministic parser archives across timestamps', async () => {
    vi.useFakeTimers();

    mkdirSync(tempDir, { recursive: true });
    writeFileSync(join(tempDir, 'parser.ts'), 'export const parser = true;\n');

    vi.setSystemTime(new Date('2026-04-03T10:00:00Z'));
    const archiveA = await createParserArchive(tempDir, ['parser.ts']);

    vi.setSystemTime(new Date('2026-04-03T10:05:00Z'));
    const archiveB = await createParserArchive(tempDir, ['parser.ts']);

    expect(archiveA.equals(archiveB)).toBe(true);
  });

  it('skips upload when remote parser version already matches local archive', async () => {
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(join(tempDir, 'parser.ts'), 'export const parser = true;\n');

    const archive = await createParserArchive(tempDir, ['parser.ts']);
    const version = createHash('sha256').update(archive).digest('hex').slice(0, 16);

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ version }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    await pushParserToServer({
      workspaceId: 'ws_123',
      repoName: 'demo-repo',
      parserDir: tempDir,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('https://api.test/api/v1/workspaces/ws_123/parsers/demo-repo/meta', {
      headers: { Authorization: 'Bearer cdt_test' },
    });
  });

  it('uploads profile.ts when no legacy parser.ts exists (profile-authored repos)', async () => {
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(join(tempDir, 'profile.ts'), 'export const profile = {};\n');

    const fetchMock = vi.fn().mockImplementation(async (url: string) =>
      url.endsWith('/meta')
        ? new Response('not found', { status: 404 })
        : new Response(JSON.stringify({ version: 'abc123' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
    );
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const result = await pushParserToServer({
      workspaceId: 'ws_123',
      repoName: 'profile-repo',
      parserDir: tempDir,
    });

    expect(result).toBe('uploaded');
    // meta probe (404) + fresh upload POST
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const uploadCall = fetchMock.mock.calls.find(([u]: [string]) => !u.endsWith('/meta'));
    expect(uploadCall?.[0]).toBe('https://api.test/api/v1/workspaces/ws_123/parsers/profile-repo');
  });

  it('throws when neither profile.ts nor parser.ts is present', async () => {
    mkdirSync(tempDir, { recursive: true });

    await expect(
      pushParserToServer({ workspaceId: 'ws_123', repoName: 'empty-repo', parserDir: tempDir }),
    ).rejects.toThrow(/No parser artifact found/);
  });
});
