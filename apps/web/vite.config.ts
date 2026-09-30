/// <reference types="vitest" />
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Dev-only same-origin proxy target: the NestJS server (apps/server) in local
// dev. In production this SPA is served BY that same server (single-origin,
// docs/web-ui-plan-2026-07.md §3.4) so no proxy is needed there.
const SERVER_ORIGIN = process.env.SERVER_ORIGIN ?? 'http://localhost:3000';

// Root-served path prefixes that must be proxied to the server in dev so the
// SPA behaves the same as it will single-origin in production. Mirrors
// apps/server/src/libs/spa-serving.ts's ROOT_ROUTES (mcp/sse/messages + OAuth
// discovery/endpoints) plus the /api/v1 prefix — that file stays the source
// of truth; keep this list in sync with it by hand.
//
// Each entry is a regex matching the path's first segment exactly (either the
// whole path or followed by `/`), not a string prefix. Vite's plain-string
// proxy keys match on string-prefix, which diverges from prod's exact-segment
// isReservedPath semantics: a string key '/token' would also proxy
// '/tokens-page' in dev, while prod's isReservedPath only reserves the exact
// 'token' first segment and SPA-serves '/tokens-page'. The regex form
// (`^/token(/|$)`) matches only the exact segment, keeping dev behavior
// aligned with prod.
const PROXIED_PATHS = [
  '/api',
  '/mcp',
  '/sse',
  '/messages',
  '/authorize',
  '/callback',
  '/token',
  '/revoke',
  '/register',
  '/.well-known',
];

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  build: {
    sourcemap: false,
  },
  server: {
    proxy: Object.fromEntries(
      PROXIED_PATHS.map((path) => [
        `^${path.replaceAll('.', '\\.')}(/|$)`,
        { target: SERVER_ORIGIN, changeOrigin: true },
      ]),
    ),
    // Known dev-flow quirk (do NOT "fix"): OAuth returnTo resolves against
    // the server origin (SERVER_ORIGIN, :3000), so post-login in Vite dev you
    // land on the server port, not :5173 — navigate back to :5173 manually
    // (cookies ignore ports, so :5173 is already logged in). returnTo stays
    // relative-only because validateReturnTo rejects absolute URLs by design
    // (open-redirect surface) — not because of cookie scoping.
  },
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    setupFiles: ['./src/test/setup.ts'],
    // Headroom over the 5s asyncUtilTimeout in setup.ts: a starved CI runner
    // must hit the Testing Library timeout (useful error) before the vitest
    // one (opaque "test timed out").
    testTimeout: 15_000,
  },
});
