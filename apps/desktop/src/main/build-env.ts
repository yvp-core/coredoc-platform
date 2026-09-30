/**
 * Build-time defaults injected by electron-vite `define`.
 * Runtime env (workspace .env / OS env) can override these values.
 */

declare const __COREDOC_DEFAULT_SERVER_URL__: string | undefined;
declare const __COREDOC_DEFAULT_WEB_URL__: string | undefined;
declare const __COREDOC_DEFAULT_POSTHOG_KEY__: string | undefined;
declare const __COREDOC_DEFAULT_POSTHOG_HOST__: string | undefined;

function normalize(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export const BUNDLED_COREDOC_SERVER_URL = normalize(
  typeof __COREDOC_DEFAULT_SERVER_URL__ === 'string' ? __COREDOC_DEFAULT_SERVER_URL__ : '',
);

export const BUNDLED_COREDOC_WEB_URL = normalize(
  typeof __COREDOC_DEFAULT_WEB_URL__ === 'string' ? __COREDOC_DEFAULT_WEB_URL__ : '',
);

export const BUNDLED_POSTHOG_KEY = normalize(
  typeof __COREDOC_DEFAULT_POSTHOG_KEY__ === 'string' ? __COREDOC_DEFAULT_POSTHOG_KEY__ : '',
);

export const BUNDLED_POSTHOG_HOST = normalize(
  typeof __COREDOC_DEFAULT_POSTHOG_HOST__ === 'string' ? __COREDOC_DEFAULT_POSTHOG_HOST__ : '',
);
