import { describe, expect, it, vi } from 'vitest';

// e2e-mode is side-effect-free (the boundary is applied by e2e-mode-boot.ts), so it
// imports cleanly with no electron mock — that is what keeps production consumers of
// isE2EMode from dragging app.setPath into unrelated test suites.
import { applyE2EMode, isE2EMode, resolveE2EAuthFile, resolveE2EMode, resolveE2EWorkspaceDir } from './e2e-mode.js';

const FULL_ENV = {
  COREDOC_DESKTOP_E2E: '1',
  COREDOC_DESKTOP_E2E_USER_DATA_DIR: '/tmp/coredoc-e2e-profile',
  COREDOC_DESKTOP_E2E_SERVER_URL: 'http://127.0.0.1:41999',
  COREDOC_DESKTOP_E2E_WORKSPACE_DIR: '/tmp/coredoc-e2e-workspace',
};

const exists = () => true;

describe('e2e mode detection', () => {
  it('is on only for the exact opt-in value', () => {
    expect(isE2EMode({ COREDOC_DESKTOP_E2E: '1' })).toBe(true);
  });

  it('is off when unset, empty, or explicitly disabled', () => {
    expect(isE2EMode({})).toBe(false);
    expect(isE2EMode({ COREDOC_DESKTOP_E2E: '' })).toBe(false);
    expect(isE2EMode({ COREDOC_DESKTOP_E2E: '  ' })).toBe(false);
    expect(isE2EMode({ COREDOC_DESKTOP_E2E: '0' })).toBe(false);
  });

  it('throws on any other value instead of failing open into a non-hermetic run', () => {
    expect(() => isE2EMode({ COREDOC_DESKTOP_E2E: 'true' })).toThrow(/COREDOC_DESKTOP_E2E/);
    expect(() => isE2EMode({ COREDOC_DESKTOP_E2E: 'yes' })).toThrow(/COREDOC_DESKTOP_E2E/);
    expect(() => isE2EMode({ COREDOC_DESKTOP_E2E: '2' })).toThrow(/COREDOC_DESKTOP_E2E/);
  });
});

describe('resolveE2EMode', () => {
  it('is a no-op without the flag', () => {
    expect(resolveE2EMode({ COREDOC_DESKTOP_E2E_USER_DATA_DIR: '/tmp/x' }, false, exists)).toBeNull();
  });

  it('refuses to run against a packaged application', () => {
    expect(() => resolveE2EMode(FULL_ENV, true, exists)).toThrow(/development builds/);
  });

  it('fails fast when the hermetic profile dir is missing', () => {
    expect(() => resolveE2EMode({ ...FULL_ENV, COREDOC_DESKTOP_E2E_USER_DATA_DIR: undefined }, false, exists)).toThrow(
      /COREDOC_DESKTOP_E2E_USER_DATA_DIR/,
    );
  });

  it('fails fast when the fixture server url is missing', () => {
    expect(() => resolveE2EMode({ ...FULL_ENV, COREDOC_DESKTOP_E2E_SERVER_URL: '  ' }, false, exists)).toThrow(
      /COREDOC_DESKTOP_E2E_SERVER_URL/,
    );
  });

  it('fails fast when the seeded workspace dir is missing', () => {
    expect(() => resolveE2EMode({ ...FULL_ENV, COREDOC_DESKTOP_E2E_WORKSPACE_DIR: undefined }, false, exists)).toThrow(
      /COREDOC_DESKTOP_E2E_WORKSPACE_DIR/,
    );
  });

  it('rejects a workspace dir that does not exist', () => {
    expect(() => resolveE2EMode(FULL_ENV, false, () => false)).toThrow(/not an existing directory/);
  });

  it.each([
    'http://api.coredoc.ai',
    'https://127.0.0.1:41999',
    'http://192.168.1.4:41999',
    'not-a-url',
  ])('rejects a non-loopback fixture server url (%s)', (url) => {
    expect(() => resolveE2EMode({ ...FULL_ENV, COREDOC_DESKTOP_E2E_SERVER_URL: url }, false, exists)).toThrow(
      /COREDOC_DESKTOP_E2E_SERVER_URL/,
    );
  });

  it('accepts localhost as well as 127.0.0.1', () => {
    expect(
      resolveE2EMode({ ...FULL_ENV, COREDOC_DESKTOP_E2E_SERVER_URL: 'http://localhost:41999' }, false, exists)
        ?.serverUrl,
    ).toBe('http://localhost:41999');
  });

  it('resolves the hermetic profile dir, fixture server url, and workspace dir', () => {
    expect(resolveE2EMode(FULL_ENV, false, exists)).toEqual({
      userDataDir: '/tmp/coredoc-e2e-profile',
      serverUrl: 'http://127.0.0.1:41999',
      workspaceDir: '/tmp/coredoc-e2e-workspace',
    });
  });
});

describe('resolveE2EAuthFile', () => {
  it('ignores the variable entirely outside e2e mode', () => {
    expect(resolveE2EAuthFile({ COREDOC_DESKTOP_E2E_AUTH_FILE: '/tmp/creds.json' }, exists)).toBeNull();
  });

  it('is optional in e2e mode — no file means a logged-out boot', () => {
    expect(resolveE2EAuthFile(FULL_ENV, exists)).toBeNull();
    expect(resolveE2EAuthFile({ ...FULL_ENV, COREDOC_DESKTOP_E2E_AUTH_FILE: '   ' }, exists)).toBeNull();
  });

  it('rejects a relative path instead of resolving it against an unknown cwd', () => {
    expect(() => resolveE2EAuthFile({ ...FULL_ENV, COREDOC_DESKTOP_E2E_AUTH_FILE: 'creds.json' }, exists)).toThrow(
      /absolute/,
    );
  });

  it('rejects a file that does not exist instead of booting logged out', () => {
    expect(() =>
      resolveE2EAuthFile({ ...FULL_ENV, COREDOC_DESKTOP_E2E_AUTH_FILE: '/tmp/creds.json' }, () => false),
    ).toThrow(/not an existing file/);
  });

  it('returns the seeded credentials file in e2e mode', () => {
    expect(resolveE2EAuthFile({ ...FULL_ENV, COREDOC_DESKTOP_E2E_AUTH_FILE: '/tmp/creds.json' }, exists)).toBe(
      '/tmp/creds.json',
    );
  });
});

describe('resolveE2EWorkspaceDir', () => {
  it('ignores the variable entirely outside e2e mode', () => {
    expect(resolveE2EWorkspaceDir({ COREDOC_DESKTOP_E2E_WORKSPACE_DIR: '/tmp/ws' }, exists)).toBeNull();
  });

  it('is required in e2e mode — an omitted dir can no longer fall back to the dev root', () => {
    expect(() => resolveE2EWorkspaceDir({ ...FULL_ENV, COREDOC_DESKTOP_E2E_WORKSPACE_DIR: '' }, exists)).toThrow(
      /COREDOC_DESKTOP_E2E_WORKSPACE_DIR/,
    );
  });

  it('rejects a relative path instead of resolving it against an unknown cwd', () => {
    expect(() => resolveE2EWorkspaceDir({ ...FULL_ENV, COREDOC_DESKTOP_E2E_WORKSPACE_DIR: 'ws' }, exists)).toThrow(
      /absolute/,
    );
  });

  it('rejects a dir that does not exist instead of falling back to the real workspace', () => {
    expect(() => resolveE2EWorkspaceDir(FULL_ENV, () => false)).toThrow(/not an existing directory/);
  });

  it('returns the seeded workspace dir in e2e mode', () => {
    expect(resolveE2EWorkspaceDir(FULL_ENV, exists)).toBe('/tmp/coredoc-e2e-workspace');
  });
});

describe('applyE2EMode', () => {
  function makeHost() {
    return {
      mkdirRecursive: vi.fn(),
      setPath: vi.fn(),
      setServerUrl: vi.fn(),
      env: {} as NodeJS.ProcessEnv,
    };
  }

  const MODE = {
    userDataDir: '/tmp/coredoc-e2e-profile',
    serverUrl: 'http://127.0.0.1:41999',
    workspaceDir: '/tmp/coredoc-e2e-workspace',
  };

  it('creates the hermetic profile dir before redirecting userData at it', () => {
    const host = makeHost();

    applyE2EMode(host, MODE);

    expect(host.mkdirRecursive.mock.calls).toEqual([['/tmp/coredoc-e2e-profile']]);
    expect(host.setPath.mock.calls).toEqual([['userData', '/tmp/coredoc-e2e-profile']]);
    expect(host.mkdirRecursive.mock.invocationCallOrder[0]).toBeLessThan(host.setPath.mock.invocationCallOrder[0]!);
  });

  it('redirects the in-process server URL and the child-process env at the fixture server', () => {
    const host = makeHost();

    applyE2EMode(host, MODE);

    expect(host.setServerUrl.mock.calls).toEqual([['http://127.0.0.1:41999']]);
    // The in-memory override never crosses the sdk-worker/CLI process boundary.
    expect(host.env.COREDOC_SERVER_URL).toBe('http://127.0.0.1:41999');
  });

  it('disables telemetry for the whole process tree', () => {
    const host = makeHost();

    applyE2EMode(host, MODE);

    expect(host.env.COREDOC_TELEMETRY_DISABLED).toBe('1');
  });

  it('leaves the real profile, server, and env untouched when mode is null', () => {
    const host = makeHost();

    applyE2EMode(host, null);

    expect(host.mkdirRecursive).not.toHaveBeenCalled();
    expect(host.setPath).not.toHaveBeenCalled();
    expect(host.setServerUrl).not.toHaveBeenCalled();
    expect(host.env).toEqual({});
  });
});
