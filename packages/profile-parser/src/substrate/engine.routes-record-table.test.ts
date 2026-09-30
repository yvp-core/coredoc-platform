/**
 * Acceptance for `RouteRule.recordTable` — table-driven routes joined to a scene→module
 * table (R1/R2 of the PostHog frontend audit, .scratch/posthog-extraction-gaps/).
 *
 * Field evidence (posthog): `frontend/src/scenes/scenes.ts` declares 177 routes as a
 * `Record` whose keys are ALL computed (`[urls.dashboard(':id')]`) and whose values name a
 * scene (`[Scene.Dashboard, 'dashboard']`); the component lives two hops away, behind
 * `appScenes[Scene.Dashboard] = () => import('./dashboard/Dashboard')`. The generated
 * `frontend/src/products.tsx` and the per-product manifests repeat the shape with LITERAL
 * keys and a `{ import: () => import(…) }` value. No `<Route>` element, no component
 * reference near a path — every existing route detector yields zero here.
 *
 * The fixture reproduces all four measured variants plus the two failure modes the rule
 * must NOT paper over: a key that cannot const-fold (emitted `unresolved:`, never dropped)
 * and a scene module whose default export is not an emitted component (name-only, no
 * fabricated id).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExtractionProfile } from '../types.js';
import { runProfile } from './run.js';

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const FILES: Record<string, string> = {
  // ── product-local urls object, spread into the app-wide one ────────────────
  'frontend/src/products.tsx': `export const productUrls = {
    actions: (): string => '/data-management/actions',
    action: (id: string | number): string => \`/data-management/actions/\${id}\`,
}

export const productRoutes: Record<string, [string, string]> = {
    '/data-management/actions': ['Actions', 'actions'],
    '/data-management/actions/:id': ['Action', 'action'],
}

export const productScenes: Record<string, () => Promise<any>> = {
    Actions: () => import('../../products/actions/frontend/Actions'),
    Action: () => import('../../products/actions/frontend/Action'),
}
`,
  'products/actions/frontend/Actions.tsx': `export function Actions(): JSX.Element {
    return <div>actions</div>
}
export default Actions
`,
  'products/actions/frontend/Action.tsx': `export function Action(): JSX.Element {
    return <div>action</div>
}
export default Action
`,
  // ── the app-wide urls object (one spread hop into productUrls) ─────────────
  'frontend/src/scenes/urls.ts': `import { productUrls } from '~/products'

declare function combineUrl(path: string, params: Record<string, unknown>): { url: string }

export const urls = {
    ...productUrls,
    newTab: () => '/search',
    dashboard: (id: string | number): string => \`/dashboard/\${id}\`,
    dashboardTextTile: (id: string | number, textTileId: string | number): string =>
        \`/dashboard/\${id}/text-tiles/\${textTileId}\`,
    sqlEditor: (params: Record<string, unknown> = {}): string => combineUrl('/sql', params).url,
}
`,
  // ── the kea-router scene table: computed keys + tuple values ───────────────
  'frontend/src/scenes/scenes.ts': `import { Scene } from 'scenes/sceneTypes'
import { urls } from 'scenes/urls'

export const routes: Record<string, [Scene | string, string]> = {
    [urls.newTab()]: [Scene.NewTab, 'newTab'],
    [urls.dashboard(':id')]: [Scene.Dashboard, 'dashboard'],
    [urls.dashboardTextTile(':id', ':textTileId')]: [Scene.Dashboard, 'dashboardTextTile'],
    [urls.action(':id' as ActionId)]: [Scene.Action, 'action'],
    [urls.sqlEditor()]: [Scene.SqlEditor, 'sqlEditor'],
}
`,
  'frontend/src/scenes/sceneTypes.ts': `export enum Scene {
    NewTab = 'NewTab',
    Dashboard = 'Dashboard',
    Action = 'Action',
    SqlEditor = 'SqlEditor',
}
`,
  'frontend/src/scenes/appScenes.ts': `import { Scene } from 'scenes/sceneTypes'

export const appScenes: Record<Scene | string, () => any> = {
    [Scene.Dashboard]: () => import('./dashboard/Dashboard'),
    [Scene.NewTab]: () => import('./newTab/newTabConfig'),
    [Scene.Action]: () => import('../../../products/actions/frontend/Action'),
    [Scene.SqlEditor]: () => import('./sql/SqlEditor'),
}
`,
  // A scene descriptor export, no default export at all (the majority posthog shape).
  'frontend/src/scenes/dashboard/Dashboard.tsx': `export const scene = {
    component: Dashboard,
    logic: dashboardLogic,
}

export function Dashboard(): JSX.Element {
    return <div>dashboard</div>
}
`,
  // A scene descriptor whose component is IMPORTED — one hop to the declaring file.
  'frontend/src/scenes/sql/SqlEditor.tsx': `import { SqlEditorScene } from './SqlEditorScene'

export const scene = {
    component: SqlEditorScene,
}
`,
  'frontend/src/scenes/sql/SqlEditorScene.tsx': `export function SqlEditorScene(): JSX.Element {
    return <div>sql</div>
}
`,
  // Resolves as a module, but its default export is NOT a component → name-only route.
  'frontend/src/scenes/newTab/newTabConfig.ts': `export const NewTabConfig = { title: 'New tab' }
export default NewTabConfig
`,
  // ── a product manifest: literal keys + `{ import: () => import(…) }` ───────
  'products/error_tracking/manifest.tsx': `export const manifest = {
    name: 'Error tracking',
    scenes: {
        ErrorTracking: {
            import: () => import('./frontend/scenes/ErrorTrackingScene'),
            projectBased: true,
        },
    },
    routes: {
        '/error_tracking': ['ErrorTracking', 'errorTracking'],
        '/error_tracking/:id': ['ErrorTracking', 'errorTrackingIssue'],
    },
}
`,
  'products/error_tracking/frontend/scenes/ErrorTrackingScene.tsx': `export function ErrorTrackingScene(): JSX.Element {
    return <div>errors</div>
}
export default ErrorTrackingScene
`,
};

function writeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'pp-record-table-routes-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'record-table-routes-fixture', version: '1.0.0', type: 'module' }),
  );
  writeFileSync(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', jsx: 'preserve' },
      include: ['frontend', 'products'],
    }),
  );
  for (const [rel, source] of Object.entries(FILES)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, source);
  }
  return root;
}

const IMPORTS = {
  aliases: { 'scenes/*': 'frontend/src/scenes/', '~/*': 'frontend/src/', 'products/*': 'products/' },
  confineTo: ['frontend/src/', 'products/'],
};

const PROFILE: ExtractionProfile = {
  parserId: 'test-record-table-routes',
  substrate: {
    language: 'ts',
    include: ['frontend/**/*.ts', 'frontend/**/*.tsx', 'products/**/*.ts', 'products/**/*.tsx'],
    exclude: ['**/node_modules/**'],
  },
  components: {
    framework: 'react',
    functional: true,
    functionalInExtensions: ['.tsx'],
    childComponents: 'jsx-walk',
    idResolution: 'import+tsconfig',
    imports: IMPORTS,
  },
  routes: {
    recordTable: [
      {
        files: ['frontend/src/scenes/scenes.ts'],
        table: 'routes',
        path: 'key',
        sceneKey: { tupleIndex: 0 },
        sceneTable: {
          files: ['frontend/src/scenes/appScenes.ts'],
          table: 'appScenes',
          via: 'dynamic-import',
          moduleComponent: { export: 'scene', property: 'component' },
        },
        resolveComputedKeyVia: { urlsObject: 'urls', inPaths: ['frontend/src/'] },
      },
      {
        files: ['frontend/src/products.tsx'],
        table: 'productRoutes',
        path: 'key',
        sceneKey: { tupleIndex: 0 },
        sceneTable: { table: 'productScenes', via: 'dynamic-import' },
      },
      {
        files: ['products/*/manifest.tsx'],
        table: 'routes',
        path: 'key',
        sceneKey: { tupleIndex: 0 },
        sceneTable: { table: 'scenes', via: 'dynamic-import', property: 'import' },
      },
    ],
  },
};

describe('routes — recordTable (path-keyed table joined to a scene→module table)', () => {
  it('reads literal + computed keys and resolves the component two hops away', async () => {
    dir = writeFixture();
    const { repo } = await runProfile(PROFILE, dir, 'record-table-routes');
    const routes = repo.routes ?? [];
    const byPath = new Map(routes.map((r) => [r.path, r]));
    const componentIdOf = (file: string, name: string): string | undefined =>
      (repo.components ?? []).find((c) => c.location.filePath === file && c.name === name)?.id;

    // ── literal keys, same-file scene table (a generated product route table) ──
    expect(byPath.get('/data-management/actions')?.componentName).toBe('Actions');
    expect(byPath.get('/data-management/actions')?.componentId).toBe(
      componentIdOf('products/actions/frontend/Actions.tsx', 'Actions'),
    );
    expect(byPath.get('/data-management/actions/:id')?.componentId).toBe(
      componentIdOf('products/actions/frontend/Action.tsx', 'Action'),
    );

    // ── literal keys, nested tables, thunk under a `property` (a manifest) ─────
    const errorTracking = byPath.get('/error_tracking');
    expect(errorTracking?.componentId).toBe(
      componentIdOf('products/error_tracking/frontend/scenes/ErrorTrackingScene.tsx', 'ErrorTrackingScene'),
    );
    expect(errorTracking?.location?.filePath).toBe('products/error_tracking/manifest.tsx');
    // Two paths sharing one scene stay two routes with distinct ids.
    expect(byPath.get('/error_tracking/:id')?.componentId).toBe(errorTracking?.componentId);
    expect(byPath.get('/error_tracking/:id')?.id).not.toBe(errorTracking?.id);

    // ── computed keys: const-eval of the urls object ───────────────────────────
    // no-arg arrow returning a plain string
    expect(byPath.get('/search')?.componentName).toBe('NewTabConfig');
    // one `:param` argument substituted into the template placeholder; the component
    // comes from the module's `scene` descriptor, which is what a module with NO default
    // export exposes (the majority posthog shape — default-export-only read misses it).
    expect(byPath.get('/dashboard/:id')?.componentId).toBe(
      componentIdOf('frontend/src/scenes/dashboard/Dashboard.tsx', 'Dashboard'),
    );
    // two arguments, positionally bound to the arrow's parameters
    expect(byPath.get('/dashboard/:id/text-tiles/:textTileId')?.componentId).toBe(
      componentIdOf('frontend/src/scenes/dashboard/Dashboard.tsx', 'Dashboard'),
    );
    // resolved through ONE spread hop (`urls = { ...productUrls }`), arg behind an `as` cast
    expect(byPath.get('/data-management/actions/:id')).toBeDefined();
    expect(routes.filter((r) => r.path === '/data-management/actions/:id')).toHaveLength(2);

    // ── the two failure modes ─────────────────────────────────────────────────
    // A key that does not const-fold is emitted with an unresolved marker, not dropped.
    const unresolved = routes.filter((r) => r.path.startsWith('unresolved:'));
    expect(unresolved.map((r) => r.path)).toEqual(['unresolved:urls.sqlEditor']);
    // …and it still resolves its component — here through a scene descriptor whose
    // `component` is imported, i.e. one hop past the dynamically imported module.
    expect(unresolved[0].componentId).toBe(
      componentIdOf('frontend/src/scenes/sql/SqlEditorScene.tsx', 'SqlEditorScene'),
    );
    // A scene module that resolves to a non-component yields a name-only route.
    expect(byPath.get('/search')?.componentId).toBeUndefined();

    // Every route the tables declare is emitted, and every id is a real component id.
    expect(routes).toHaveLength(9);
    const validIds = new Set((repo.components ?? []).map((c) => c.id));
    for (const r of routes) {
      expect(r.isLazy).toBe(true);
      if (r.componentId) expect(validIds.has(r.componentId)).toBe(true);
    }
  });
});
