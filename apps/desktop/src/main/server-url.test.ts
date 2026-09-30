import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ServerUrlSource } from '../shared/ipc-types.js';

vi.mock('./build-env.js', () => ({ BUNDLED_COREDOC_SERVER_URL: 'https://bundled.example' }));

const managedConfig = { serverUrl: null as string | null, updateFeedUrl: null as string | null };
vi.mock('./managed-config.js', () => ({ getManagedConfig: () => managedConfig }));

const settings = { serverUrl: null as string | null };
const writeDesktopServerUrl = vi.fn();
vi.mock('./desktop-settings.js', () => ({
  readDesktopSettings: () => ({ serverUrl: settings.serverUrl }),
  writeDesktopServerUrl: (url: string) => writeDesktopServerUrl(url),
}));

beforeEach(() => {
  vi.resetModules();
  delete process.env.COREDOC_SERVER_URL;
  managedConfig.serverUrl = null;
  settings.serverUrl = null;
  writeDesktopServerUrl.mockClear();
});

describe('resolveServerConfig precedence', () => {
  it('managed config outranks the runtime override, env and the persisted choice', async () => {
    managedConfig.serverUrl = 'https://managed.example';
    settings.serverUrl = 'https://user.example';
    process.env.COREDOC_SERVER_URL = 'https://env.example';
    const m = await import('./server-url.js');
    m.setServerUrl('https://override.example');
    expect(m.resolveServerConfig()).toEqual({ url: 'https://managed.example', source: ServerUrlSource.Managed });
  });

  it('prefers the runtime override when unmanaged', async () => {
    process.env.COREDOC_SERVER_URL = 'https://env.example';
    const m = await import('./server-url.js');
    m.setServerUrl('https://override.example');
    expect(m.resolveServerConfig()).toEqual({ url: 'https://override.example', source: ServerUrlSource.Override });
  });

  it('falls back to COREDOC_SERVER_URL env over the persisted choice', async () => {
    process.env.COREDOC_SERVER_URL = 'https://env.example';
    settings.serverUrl = 'https://user.example';
    const m = await import('./server-url.js');
    expect(m.resolveServerConfig()).toEqual({ url: 'https://env.example', source: ServerUrlSource.Env });
  });

  it('falls back to the persisted user choice over the bundled default', async () => {
    settings.serverUrl = 'https://user.example';
    const m = await import('./server-url.js');
    expect(m.resolveServerConfig()).toEqual({ url: 'https://user.example', source: ServerUrlSource.User });
  });

  it('falls back to the bundled default when nothing else is set', async () => {
    const m = await import('./server-url.js');
    expect(m.resolveServerConfig()).toEqual({ url: 'https://bundled.example', source: ServerUrlSource.Bundled });
    expect(m.getConfiguredServerUrl()).toBe('https://bundled.example');
  });

  it('falls back to localhost when there is no bundled default', async () => {
    vi.doMock('./build-env.js', () => ({ BUNDLED_COREDOC_SERVER_URL: '' }));
    const m = await import('./server-url.js');
    expect(m.resolveServerConfig()).toEqual({ url: 'http://localhost:3000', source: ServerUrlSource.Default });
    vi.doUnmock('./build-env.js');
  });
});

describe('user server choice', () => {
  it('persists the choice and applies it to the current session', async () => {
    const m = await import('./server-url.js');
    m.setUserServerUrl('https://user.example');
    expect(writeDesktopServerUrl).toHaveBeenCalledWith('https://user.example');
    expect(m.getConfiguredServerUrl()).toBe('https://user.example');
  });

  it('survives logout: resetServerUrl falls back to the persisted choice', async () => {
    const m = await import('./server-url.js');
    m.setUserServerUrl('https://user.example');
    m.resetServerUrl();
    expect(m.resolveServerConfig()).toEqual({ url: 'https://user.example', source: ServerUrlSource.User });
  });

  it('refuses to change the server when a managed config pins it', async () => {
    managedConfig.serverUrl = 'https://managed.example';
    const m = await import('./server-url.js');
    expect(() => m.setUserServerUrl('https://user.example')).toThrow(/managed by your organization/i);
    expect(writeDesktopServerUrl).not.toHaveBeenCalled();
  });
});

describe('resetServerUrl', () => {
  it('drops the override so resolution falls back again', async () => {
    process.env.COREDOC_SERVER_URL = 'https://env.example';
    const m = await import('./server-url.js');
    m.setServerUrl('https://override.example');
    expect(m.getConfiguredServerUrl()).toBe('https://override.example');
    m.resetServerUrl();
    expect(m.getConfiguredServerUrl()).toBe('https://env.example');
  });
});
