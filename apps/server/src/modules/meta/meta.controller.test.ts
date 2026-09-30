import { describe, it, expect } from 'vitest';
import { MetaController } from './meta.controller.js';
import { MIN_CLIENT_VERSION, SERVER_VERSION } from './server-version.js';

describe('MetaController', () => {
  it('publishes the server version and the minimum client version', () => {
    expect(new MetaController().getMeta()).toEqual({
      version: SERVER_VERSION,
      minClientVersion: MIN_CLIENT_VERSION,
    });
  });

  it('reports a semver-shaped server version read from the package', () => {
    expect(SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
