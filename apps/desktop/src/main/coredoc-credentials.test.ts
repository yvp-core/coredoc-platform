import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type CoredocCredentials,
  getWorkspaceEntry,
  isCredValid,
  readCreds,
  setWorkspaceEntry,
  writeCreds,
} from './coredoc-credentials.js';

let dir: string;
let credsPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'coredoc-creds-'));
  // Nested to also exercise mkdir -p of the parent (mirrors ~/.coredoc creation).
  credsPath = join(dir, '.coredoc', 'credentials.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('writeCreds / readCreds round-trip', () => {
  it('persists and reads back the full document, creating the parent dir', async () => {
    const creds: CoredocCredentials = {
      accessToken: 'tok',
      expiresAt: 123,
      serverUrl: 'https://api.example',
      workspaces: { ws1: { otelToken: 'ot', serverUrl: 'https://ws.example' } },
    };
    await writeCreds(creds, credsPath);
    expect(await readCreds(credsPath)).toEqual(creds);
  });

  it('writes 2-space JSON with a trailing newline (byte-parity with the plugin)', async () => {
    const creds: CoredocCredentials = { accessToken: 'tok', workspaces: { ws1: { otelToken: 'ot' } } };
    await writeCreds(creds, credsPath);
    const raw = await readFile(credsPath, 'utf8');
    expect(raw).toBe(`${JSON.stringify(creds, null, 2)}\n`);
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw).toContain('\n  "accessToken"'); // 2-space indent
  });

  it('writes the file at mode 0600', async () => {
    await writeCreds({ accessToken: 'tok' }, credsPath);
    const mode = (await stat(credsPath)).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe('readCreds edge cases', () => {
  it('returns null when the file is absent', async () => {
    expect(await readCreds(join(dir, 'nope.json'))).toBeNull();
  });

  it('returns null on unparseable JSON', async () => {
    const p = join(dir, 'bad.json');
    await writeFile(p, 'not json {{{', 'utf8');
    expect(await readCreds(p)).toBeNull();
  });

  it('returns null on an empty / whitespace-only file', async () => {
    const p = join(dir, 'empty.json');
    await writeFile(p, '   \n', 'utf8');
    expect(await readCreds(p)).toBeNull();
  });

  it('is BOM-tolerant (strips a leading U+FEFF before parsing)', async () => {
    const p = join(dir, 'bom.json');
    await writeFile(p, `﻿${JSON.stringify({ accessToken: 'tok' })}`, 'utf8');
    expect(await readCreds(p)).toEqual({ accessToken: 'tok' });
  });
});

describe('getWorkspaceEntry', () => {
  it('reads an existing entry and returns undefined for a missing one', () => {
    const creds: CoredocCredentials = { workspaces: { ws1: { otelToken: 'ot' } } };
    expect(getWorkspaceEntry(creds, 'ws1')).toEqual({ otelToken: 'ot' });
    expect(getWorkspaceEntry(creds, 'ws2')).toBeUndefined();
    expect(getWorkspaceEntry(null, 'ws1')).toBeUndefined();
  });
});

describe('setWorkspaceEntry merge semantics', () => {
  it('merges: top-level fields and other workspaces survive', () => {
    const creds: CoredocCredentials = {
      accessToken: 'tok',
      expiresAt: 999,
      serverUrl: 'https://api.example',
      workspaces: { ws1: { otelToken: 'old1' }, ws2: { otelToken: 'keep2' } },
    };
    const next = setWorkspaceEntry(creds, 'ws1', { otelToken: 'new1', serverUrl: 'https://ws1.example' });
    expect(next).toEqual({
      accessToken: 'tok',
      expiresAt: 999,
      serverUrl: 'https://api.example',
      workspaces: {
        ws1: { otelToken: 'new1', serverUrl: 'https://ws1.example' },
        ws2: { otelToken: 'keep2' },
      },
    });
    // Input is not mutated (pure).
    expect(creds.workspaces?.ws1).toEqual({ otelToken: 'old1' });
  });

  it('seeds the workspaces map when creds is null/empty', () => {
    expect(setWorkspaceEntry(null, 'ws1', { otelToken: 'ot' })).toEqual({
      workspaces: { ws1: { otelToken: 'ot' } },
    });
  });

  it('round-trips through disk preserving the merge', async () => {
    await writeCreds({ accessToken: 'tok', workspaces: { ws2: { otelToken: 'keep2' } } }, credsPath);
    const loaded = await readCreds(credsPath);
    const next = setWorkspaceEntry(loaded, 'ws1', { otelToken: 'ot1' });
    await writeCreds(next, credsPath);
    expect(await readCreds(credsPath)).toEqual({
      accessToken: 'tok',
      workspaces: { ws2: { otelToken: 'keep2' }, ws1: { otelToken: 'ot1' } },
    });
  });
});

describe('isCredValid', () => {
  it('true only for a present token with a future expiry', () => {
    expect(isCredValid({ accessToken: 'tok', expiresAt: Date.now() + 10_000 })).toBe(true);
    expect(isCredValid({ accessToken: 'tok', expiresAt: Date.now() - 10_000 })).toBe(false);
    expect(isCredValid({ expiresAt: Date.now() + 10_000 })).toBe(false);
    expect(isCredValid(null)).toBe(false);
  });
});
