/**
 * Acceptance for `routes.joinNestedPaths`: a react-router route nested under a parent
 * route with a `path` (JSX children or `children:` config) emits the joined absolute
 * path, and an index route takes its parent's path. Without the flag, nested paths
 * stay as written.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExtractionProfile } from '../types.js';
import type { RouteRule } from '../types/frontend.js';
import { runProfile } from './run.js';

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

// The comment carries a non-ASCII character so a byte/char offset mix-up would surface.
const JSX_ROUTES = `import { Route, Routes } from 'react-router-dom';
import { Shell, Widgets, WidgetDetail, Home, Grants, About, Legacy } from './pages';

// Ünïcode before the routes.
export const AppRoutes = () => (
  <Routes>
    <Route path="/acme/:region/:orgId" element={<Shell />}>
      <Route index element={<Home />} />
      <Route path="widgets" element={<Widgets />}>
        <Route path=":widgetId" element={<WidgetDetail />} />
      </Route>
      <Route path="grants/*" element={<Grants />} />
      <Route path="/legacy" element={<Legacy />} />
    </Route>
    <Route path="about" element={<About />} />
  </Routes>
);
`;

const CONFIG_ROUTES = `import { Jobs, JobDetail, JobsHome, Clients } from './pages';

export const routes = [
  {
    path: '/acme',
    component: Clients,
    children: [
      { path: 'jobs', component: Jobs, children: [{ path: ':jobId', component: JobDetail }] },
      { index: true, component: JobsHome },
    ],
  },
];
`;

async function routesFor(file: string, source: string, rule: RouteRule): Promise<string[][]> {
  dir = mkdtempSync(join(tmpdir(), 'pp-routes-nested-'));
  writeFileSync(join(dir, file), source);
  const profile: ExtractionProfile = {
    parserId: 'test-nested-routes',
    substrate: { language: 'ts', include: ['**/*.tsx'], exclude: ['**/node_modules/**'] },
    routes: rule,
  };
  const { repo } = await runProfile(profile, dir, 'routes-test');
  return (repo.routes ?? []).map((r) => [r.path, r.componentName]).sort();
}

describe('routes.joinNestedPaths — nested react-router routes', () => {
  it('joins JSX-nested route paths onto their parent and gives index routes the parent path', async () => {
    const routes = await routesFor('routes.tsx', JSX_ROUTES, { componentProp: true, joinNestedPaths: true });
    expect(routes).toEqual([
      ['/acme/:region/:orgId', 'Home'],
      ['/acme/:region/:orgId', 'Shell'],
      ['/acme/:region/:orgId/grants/*', 'Grants'],
      ['/acme/:region/:orgId/widgets', 'Widgets'],
      ['/acme/:region/:orgId/widgets/:widgetId', 'WidgetDetail'],
      // An absolute child path is already complete; a top-level relative path has no parent.
      ['/legacy', 'Legacy'],
      ['about', 'About'],
    ]);
  });

  it('detects an index route whatever its attribute order, past an arrow-function attribute', async () => {
    const source = `import { Route, Routes } from 'react-router-dom';
import { Shell, Home, Dashboard } from './pages';

export const AppRoutes = () => (
  <Routes>
    <Route path="/acme" element={<Shell />}>
      <Route element={<Home />} index />
    </Route>
    <Route path="/widgets" element={<Shell />}>
      <Route index loader={() => fetch('/api/widgets')} element={<Dashboard />} />
    </Route>
  </Routes>
);
`;
    const routes = await routesFor('routes.tsx', source, { componentProp: true, joinNestedPaths: true });
    expect(routes).toEqual([
      ['/acme', 'Home'],
      ['/acme', 'Shell'],
      ['/widgets', 'Dashboard'],
      ['/widgets', 'Shell'],
    ]);
  });

  it('joins `children:` config routes onto their parent and gives index routes the parent path', async () => {
    const routes = await routesFor('routes.tsx', CONFIG_ROUTES, { configArray: true, joinNestedPaths: true });
    expect(routes).toEqual([
      ['/acme', 'Clients'],
      ['/acme', 'JobsHome'],
      ['/acme/jobs', 'Jobs'],
      ['/acme/jobs/:jobId', 'JobDetail'],
    ]);
  });

  it('leaves nested paths as written without the flag', async () => {
    const routes = await routesFor('routes.tsx', JSX_ROUTES, { componentProp: true });
    expect(routes).toContainEqual(['widgets', 'Widgets']);
    expect(routes.map(([, name]) => name)).not.toContain('Home');
  });
});
