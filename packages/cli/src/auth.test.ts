import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { fileState, readFileMock, writeFileMock, unlinkMock } = vi.hoisted(() => {
  const state: { contents: string | null } = { contents: null };
  return {
    fileState: state,
    readFileMock: vi.fn(async () => {
      if (state.contents === null) throw new Error('ENOENT');
      return state.contents;
    }),
    writeFileMock: vi.fn(async (_path: string, contents: string) => {
      state.contents = contents;
    }),
    unlinkMock: vi.fn(async () => {
      if (state.contents === null) throw new Error('ENOENT');
      state.contents = null;
    }),
  };
});

vi.mock('node:fs/promises', () => ({
  chmod: vi.fn(async () => undefined),
  mkdir: vi.fn(async () => undefined),
  readFile: readFileMock,
  rename: vi.fn(async () => undefined),
  writeFile: writeFileMock,
  unlink: unlinkMock,
}));

import { getCredentials, getToken, logout, type StoredCredentials, storeCredentials } from './auth.js';

const auth: StoredCredentials = {
  accessToken: 'access-new',
  refreshToken: 'refresh-new',
  expiresAt: 2_000_000_000_000,
  userId: 'user-1',
  email: 'user@example.com',
  serverUrl: 'https://api.example',
};

const savedToken = process.env.COREDOC_TOKEN;

beforeEach(() => {
  vi.clearAllMocks();
  fileState.contents = null;
  delete process.env.COREDOC_TOKEN;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (savedToken === undefined) delete process.env.COREDOC_TOKEN;
  else process.env.COREDOC_TOKEN = savedToken;
});

describe('shared credentials persistence', () => {
  it('login storage updates auth fields without clobbering workspace OTel tokens or unknown fields', async () => {
    fileState.contents = JSON.stringify({
      accessToken: 'access-old',
      workspaces: { 'ws-1': { otelToken: 'otel-1', serverUrl: 'https://api.example' } },
      futureField: { keep: true },
    });

    await storeCredentials(auth);

    expect(JSON.parse(fileState.contents!)).toEqual({
      ...auth,
      workspaces: { 'ws-1': { otelToken: 'otel-1', serverUrl: 'https://api.example' } },
      futureField: { keep: true },
    });
    expect(writeFileMock).toHaveBeenCalledTimes(1);
  });

  it('logout removes only auth fields and preserves workspace OTel tokens', async () => {
    fileState.contents = JSON.stringify({
      ...auth,
      workspaces: { 'ws-1': { otelToken: 'otel-1' } },
    });

    await logout();

    expect(JSON.parse(fileState.contents!)).toEqual({ workspaces: { 'ws-1': { otelToken: 'otel-1' } } });
    expect(unlinkMock).not.toHaveBeenCalled();
    expect(await getCredentials()).toBeNull();
    expect(await getToken()).toBeNull();
  });

  it('continues to read legacy auth documents that predate refresh and identity fields', async () => {
    fileState.contents = JSON.stringify({
      accessToken: 'legacy-access',
      expiresAt: 2_000_000_000_000,
      serverUrl: 'https://api.example',
      workspaces: { 'ws-1': { otelToken: 'otel-1' } },
    });

    expect(await getToken()).toBe('legacy-access');
    expect(await getCredentials()).toEqual({
      accessToken: 'legacy-access',
      refreshToken: '',
      expiresAt: 2_000_000_000_000,
      userId: '',
      email: '',
      serverUrl: 'https://api.example',
    });
  });

  it('logout deletes an auth-only credentials file', async () => {
    fileState.contents = JSON.stringify(auth);

    await logout();

    expect(fileState.contents).toBeNull();
    expect(unlinkMock).toHaveBeenCalledTimes(1);
  });
});
