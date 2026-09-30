/**
 * Acceptance for the config-object route pass under `routes.configArray`: route
 * factories that take a `{ path, component }` config object (TanStack Router's
 * `createRoute`) must emit routes even when the object uses single quotes and has
 * function-valued props (`beforeLoad`, `validateSearch`) between the two keys —
 * both of which the historical regex pass misses.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExtractionProfile } from '../types.js';
import { runProfile } from './run.js';

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const ROUTER = `import { createRootRoute, createRoute } from '@tanstack/react-router';
import { LoginPage } from './pages/LoginPage';
import { WorkspaceShell } from './pages/WorkspaceShell';

const rootRoute = createRootRoute({
  component: RootLayout,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  validateSearch: (search: Record<string, unknown>): { redirect?: string } => ({
    redirect: typeof search.redirect === 'string' ? search.redirect : undefined,
  }),
  component: LoginPage,
});

const workspaceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/w/$slug',
  beforeLoad: async ({ context }) => {
    await context.queryClient.ensureQueryData(meQueryOptions);
  },
  component: WorkspaceShell,
});

// Not a route config: has a path but no component identifier.
const other = { path: '/ignored', component: buildComponent() };
`;

describe('routes.configArray — config-object route factories (TanStack createRoute)', () => {
  it('emits a route per { path, component } object, quote-agnostic and brace-safe', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pp-routes-'));
    writeFileSync(join(dir, 'router.tsx'), ROUTER);
    const profile: ExtractionProfile = {
      parserId: 'test-config-object-routes',
      substrate: { language: 'ts', include: ['**/*.tsx'], exclude: ['**/node_modules/**'] },
      routes: { configArray: true },
    };
    const { repo } = await runProfile(profile, dir, 'routes-test');
    const routes = (repo.routes ?? []).map((r) => [r.path, r.componentName]).sort();
    // rootRoute has no `path` and the `other` object's component is a call, not an
    // identifier — neither is a route.
    expect(routes).toEqual([
      ['/login', 'LoginPage'],
      ['/w/$slug', 'WorkspaceShell'],
    ]);
  });
});
