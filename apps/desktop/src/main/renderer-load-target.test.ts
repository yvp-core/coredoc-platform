import { describe, expect, it } from 'vitest';
import { resolveRendererLoadTarget } from './renderer-load-target.js';

describe('renderer load target', () => {
  it('uses the bundled renderer in a packaged app regardless of development environment variables', () => {
    expect(
      resolveRendererLoadTarget(true, {
        NODE_ENV: 'development',
        ELECTRON_RENDERER_URL: 'http://localhost:5173',
      }),
    ).toEqual({ type: 'file' });
  });

  it('preserves electron-vite renderer URLs for unpackaged development', () => {
    expect(resolveRendererLoadTarget(false, { ELECTRON_RENDERER_URL: 'http://localhost:4173' })).toEqual({
      type: 'url',
      url: 'http://localhost:4173',
    });
  });

  it('falls back to the default Vite URL for unpackaged development', () => {
    expect(resolveRendererLoadTarget(false, {})).toEqual({
      type: 'url',
      url: 'http://localhost:5173',
    });
  });
});
