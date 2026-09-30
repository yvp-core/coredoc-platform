export type RendererLoadTarget = { type: 'file' } | { type: 'url'; url: string };

const DEFAULT_DEVELOPMENT_RENDERER_URL = 'http://localhost:5173';

export function resolveRendererLoadTarget(isPackaged: boolean, env: NodeJS.ProcessEnv): RendererLoadTarget {
  // Packaged apps must not let ambient development variables redirect the
  // BrowserWindow away from the renderer bundled inside the application.
  if (isPackaged) return { type: 'file' };

  return {
    type: 'url',
    url: env.ELECTRON_RENDERER_URL || DEFAULT_DEVELOPMENT_RENDERER_URL,
  };
}
