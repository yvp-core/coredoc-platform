import { describe, expect, it, vi } from 'vitest';
import { configureDesktopQaDebugging, parseDesktopQaPort } from './qa-debug.js';

describe('desktop QA debugging', () => {
  it('stays disabled without explicit opt-in', () => {
    expect(parseDesktopQaPort(undefined)).toBeNull();
    expect(parseDesktopQaPort('')).toBeNull();
  });

  it('rejects malformed or privileged ports', () => {
    expect(() => parseDesktopQaPort('abc')).toThrow(/integer between 1024 and 65535/);
    expect(() => parseDesktopQaPort('80')).toThrow(/integer between 1024 and 65535/);
    expect(() => parseDesktopQaPort('65536')).toThrow(/integer between 1024 and 65535/);
  });

  it('binds an opted-in development endpoint to loopback', () => {
    const appendSwitch = vi.fn();

    expect(configureDesktopQaDebugging({ appendSwitch }, { COREDOC_DESKTOP_QA_PORT: '9333' }, false)).toBe(9333);
    expect(appendSwitch.mock.calls).toEqual([
      ['remote-debugging-address', '127.0.0.1'],
      ['remote-debugging-port', '9333'],
    ]);
  });

  it('refuses to expose a packaged application', () => {
    expect(() =>
      configureDesktopQaDebugging({ appendSwitch: vi.fn() }, { COREDOC_DESKTOP_QA_PORT: '9333' }, true),
    ).toThrow(/development builds/);
  });
});
