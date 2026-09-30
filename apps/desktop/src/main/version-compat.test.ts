import { describe, it, expect, vi } from 'vitest';
import { ServerCompatState } from '../shared/ipc-types.js';
import {
  compareSemver,
  deriveCompatState,
  getServerCompat,
  MIN_SERVER_VERSION,
  refreshServerCompat,
  resetServerCompat,
  resolveServerCompat,
} from './version-compat.js';

describe('compareSemver', () => {
  it('orders by major, then minor, then patch', () => {
    expect(compareSemver('1.2.3', '1.2.3')).toBe(0);
    expect(compareSemver('1.2.3', '2.0.0')).toBe(-1);
    expect(compareSemver('1.10.0', '1.9.9')).toBe(1);
    expect(compareSemver('1.2.3', '1.2.4')).toBe(-1);
  });

  it('ignores prerelease and build suffixes', () => {
    expect(compareSemver('1.2.3-rc.1', '1.2.3')).toBe(0);
    expect(compareSemver('1.2.3+build.7', '1.2.4')).toBe(-1);
  });

  it('throws on a non-semver version instead of guessing', () => {
    expect(() => compareSemver('nightly', '1.0.0')).toThrow(TypeError);
    expect(() => compareSemver('1.2', '1.0.0')).toThrow(TypeError);
  });
});

describe('deriveCompatState', () => {
  it('is compatible when both bounds are satisfied', () => {
    expect(deriveCompatState('1.1.0', { version: MIN_SERVER_VERSION, minClientVersion: '1.0.0' })).toEqual({
      state: ServerCompatState.Compatible,
      serverVersion: MIN_SERVER_VERSION,
      clientVersion: '1.1.0',
    });
  });

  it('reports serverTooOld below MIN_SERVER_VERSION', () => {
    expect(deriveCompatState('1.1.0', { version: '0.9.0', minClientVersion: '0.9.0' })).toEqual({
      state: ServerCompatState.ServerTooOld,
      serverVersion: '0.9.0',
      clientVersion: '1.1.0',
    });
  });

  it('treats a missing meta endpoint as serverTooOld with no known version', () => {
    expect(deriveCompatState('1.1.0', null)).toEqual({
      state: ServerCompatState.ServerTooOld,
      serverVersion: null,
      clientVersion: '1.1.0',
    });
  });

  it('reports clientTooOld below the server-advertised minimum', () => {
    expect(deriveCompatState('1.1.0', { version: '3.0.0', minClientVersion: '2.0.0' })).toEqual({
      state: ServerCompatState.ClientTooOld,
      serverVersion: '3.0.0',
      clientVersion: '1.1.0',
    });
  });

  it('prefers serverTooOld when both bounds are violated', () => {
    expect(deriveCompatState('1.1.0', { version: '1.0.0', minClientVersion: '9.0.0' }).state).toBe(
      ServerCompatState.ServerTooOld,
    );
  });
});

describe('resolveServerCompat', () => {
  it('maps a 404 from the meta endpoint to serverTooOld', async () => {
    const fetchMeta = vi.fn().mockRejectedValue(
      Object.assign(new Error('API GET /api/v1/meta failed (404)'), {
        status: 404,
      }),
    );

    expect(await resolveServerCompat('1.1.0', fetchMeta)).toEqual({
      state: ServerCompatState.ServerTooOld,
      serverVersion: null,
      clientVersion: '1.1.0',
    });
  });

  it('returns a verdict for a matching server', async () => {
    const fetchMeta = vi.fn().mockResolvedValue({ version: '1.1.0', minClientVersion: '1.0.0' });

    expect(await resolveServerCompat('1.1.0', fetchMeta)).toEqual({
      state: ServerCompatState.Compatible,
      serverVersion: '1.1.0',
      clientVersion: '1.1.0',
    });
  });

  it('returns null (unknown, no banner) when the server is unreachable', async () => {
    const fetchMeta = vi.fn().mockRejectedValue(new Error('fetch failed'));

    expect(await resolveServerCompat('1.1.0', fetchMeta)).toBeNull();
  });

  it('returns null (unknown) on a 500 rather than blaming the server version', async () => {
    const fetchMeta = vi.fn().mockRejectedValue(Object.assign(new Error('boom'), { status: 500 }));

    expect(await resolveServerCompat('1.1.0', fetchMeta)).toBeNull();
  });

  it('returns null on a malformed or non-semver meta payload', async () => {
    expect(await resolveServerCompat('1.1.0', async () => ({ version: 1 }))).toBeNull();
    expect(
      await resolveServerCompat('1.1.0', async () => ({ version: 'nightly', minClientVersion: '1.0.0' })),
    ).toBeNull();
  });
});

describe('the process-lifetime cache', () => {
  it('serves the cached verdict until it is reset', async () => {
    const fetchMeta = vi.fn().mockResolvedValue({ version: '1.1.0', minClientVersion: '1.0.0' });
    await refreshServerCompat('1.1.0', fetchMeta);

    expect(await getServerCompat('1.1.0', fetchMeta)).toMatchObject({ serverVersion: '1.1.0' });
    expect(fetchMeta).toHaveBeenCalledTimes(1);
  });

  it('re-runs the handshake after resetServerCompat (the app changed servers)', async () => {
    const oldServer = vi.fn().mockResolvedValue({ version: '1.1.0', minClientVersion: '1.0.0' });
    await refreshServerCompat('1.1.0', oldServer);

    resetServerCompat();

    const newServer = vi.fn().mockResolvedValue({ version: '2.0.0', minClientVersion: '1.0.0' });
    expect(await getServerCompat('1.1.0', newServer)).toMatchObject({ serverVersion: '2.0.0' });
    expect(newServer).toHaveBeenCalledTimes(1);
  });

  it('discards a handshake that was already in flight when the server changed', async () => {
    resetServerCompat();
    // Reassigned synchronously by the promise executor below; the initial value
    // only satisfies definite assignment.
    let landOldServer: (meta: unknown) => void = () => {
      /* replaced before use */
    };
    const oldServer = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          landOldServer = resolve;
        }),
    );

    const inFlight = refreshServerCompat('1.1.0', oldServer);
    // The user points the app at another server while the request is open.
    resetServerCompat();
    landOldServer({ version: '1.1.0', minClientVersion: '1.0.0' });

    expect(await inFlight).toBeNull();

    // The stale response must not have refilled the cache: the next read has to
    // re-handshake against the server the app is now on.
    const newServer = vi.fn().mockResolvedValue({ version: '2.0.0', minClientVersion: '1.0.0' });
    expect(await getServerCompat('1.1.0', newServer)).toMatchObject({ serverVersion: '2.0.0' });
    expect(newServer).toHaveBeenCalledTimes(1);
  });
});
