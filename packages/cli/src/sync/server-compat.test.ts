import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkServerCompat, MIN_SERVER_VERSION } from './workspace-api.js';

vi.mock('../auth.js', () => ({
  getToken: vi.fn(async () => 'cdt_test'),
  getServerUrl: vi.fn(async () => 'https://api.test'),
  authHeaders: vi.fn(async () => ({ Authorization: 'Bearer cdt_test' })),
}));

const metaResponse = (body: unknown, status = 200) =>
  vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status })) as unknown as typeof globalThis.fetch;

describe('checkServerCompat', () => {
  let originalFetch: typeof globalThis.fetch;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('queries the unauthenticated meta endpoint on the given server', async () => {
    const fetchMock = metaResponse({ version: MIN_SERVER_VERSION, minClientVersion: '1.0.0' });
    globalThis.fetch = fetchMock;

    await checkServerCompat('https://coredoc.acme.internal');

    expect((fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(
      'https://coredoc.acme.internal/api/v1/meta',
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns and continues when the server has no meta endpoint', async () => {
    globalThis.fetch = metaResponse({ statusCode: 404 }, 404);

    await expect(checkServerCompat('https://api.test')).resolves.toBeUndefined();
    expect(warn.mock.calls[0][0]).toContain('older than the CLI supports');
  });

  it('warns when the server version is below the supported line', async () => {
    globalThis.fetch = metaResponse({ version: '0.9.0', minClientVersion: '0.9.0' });

    await checkServerCompat('https://api.test');

    expect(warn.mock.calls[0][0]).toContain('Coredoc server v0.9.0 is older than this CLI supports');
  });

  it('warns when this CLI is below the server-advertised minimum', async () => {
    globalThis.fetch = metaResponse({ version: '9.9.9', minClientVersion: '9.0.0' });

    await checkServerCompat('https://api.test');

    expect(warn.mock.calls[0][0]).toContain('is older than the server supports');
  });

  it('stays silent when the versions match', async () => {
    globalThis.fetch = metaResponse({ version: MIN_SERVER_VERSION, minClientVersion: '1.0.0' });

    await checkServerCompat('https://api.test');

    expect(warn).not.toHaveBeenCalled();
  });

  it('stays silent and never throws when the server is unreachable', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof globalThis.fetch;

    await expect(checkServerCompat('https://api.test')).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('bounds the request with a timeout signal and stays silent when it aborts', async () => {
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      // What AbortSignal.timeout() rejects with once it fires.
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    await expect(checkServerCompat('https://hangs.test')).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('stays silent on a malformed or non-semver meta payload', async () => {
    globalThis.fetch = metaResponse({ version: 1 });
    await checkServerCompat('https://api.test');

    globalThis.fetch = metaResponse({ version: 'nightly', minClientVersion: '1.0.0' });
    await checkServerCompat('https://api.test');

    expect(warn).not.toHaveBeenCalled();
  });
});
