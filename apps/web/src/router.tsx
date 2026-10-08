import { QueryClient } from '@tanstack/react-query';
import {
  type RouterHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  redirect,
} from '@tanstack/react-router';
import { lazy } from 'react';
import { meQueryOptions } from './api/queries/me.js';
import { IndexPage, soleWorkspaceSlug } from './routes/index.js';
import { LoginPage } from './routes/login.js';
import { WorkspaceOverview } from './routes/overview.js';
import { WorkspaceRepos } from './routes/repos.js';
import { RootLayout } from './routes/root.js';
import { DefaultRoutePending, RouteErrorCard } from './routes/route-error.js';
import { WorkspaceSettings } from './routes/settings.js';
import { WorkspaceTeams } from './routes/teams.js';
import { WorkspaceShell, findWorkspace } from './routes/workspace.js';

// Analytics and Intent are the two chart/graph-heavy pages — lazy so their
// weight lands in chunks fetched only when opened, never on the critical
// path. The router's defaultPendingComponent covers the chunk fetch.
const WorkspaceAnalytics = lazy(() => import('./routes/analytics.js').then((m) => ({ default: m.WorkspaceAnalytics })));
const WorkspaceIntent = lazy(() => import('./routes/intent.js').then((m) => ({ default: m.WorkspaceIntent })));
// Agent runs render agent-written markdown; lazy keeps the renderer out of the main bundle.
const WorkspaceAgentRuns = lazy(() =>
  import('./routes/agent-runs.js').then((m) => ({ default: m.WorkspaceAgentRuns })),
);
const WorkspaceAgentRun = lazy(() => import('./routes/agent-run.js').then((m) => ({ default: m.WorkspaceAgentRun })));

interface RouterContext {
  queryClient: QueryClient;
}

// Code-based route tree (no file-based router codegen — YAGNI until the
// route surface justifies it).
const rootRoute = createRootRouteWithContext<RouterContext>()({
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

// Protected pattern, implemented once per guarded subtree: `beforeLoad`
// awaits the `me` query through the shared queryClient (ensureQueryData is
// cache-first — one fetch per session, not one per navigation) and decides
// where to go. A 401 CAN reach this await, but the api client handles it
// in-flight: refresh-then-retry on success, and on auth failure it starts
// the login redirect and suspends the chain (src/api/client.ts), so this
// beforeLoad never resolves while the page navigates away.
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: async ({ context }) => {
    const me = await context.queryClient.ensureQueryData(meQueryOptions);
    const slug = soleWorkspaceSlug(me);
    if (slug) {
      throw redirect({ to: '/w/$slug', params: { slug } });
    }
  },
  component: IndexPage,
});

const workspaceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/w/$slug',
  beforeLoad: async ({ context, params }) => {
    const me = await context.queryClient.ensureQueryData(meQueryOptions);
    if (!findWorkspace(me, params.slug)) {
      throw redirect({ to: '/' });
    }
  },
  component: WorkspaceShell,
});

const workspaceIndexRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: '/',
  component: WorkspaceOverview,
});

const workspaceReposRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: '/repos',
  component: WorkspaceRepos,
});

const workspaceTeamsRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: '/teams',
  component: WorkspaceTeams,
});

const workspaceAnalyticsRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: '/analytics',
  component: WorkspaceAnalytics,
});

const workspaceIntentRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: '/intent',
  component: WorkspaceIntent,
});

// Siblings, not nested: the list page renders no <Outlet/>.
const workspaceAgentRunsRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: '/agent-runs',
  component: WorkspaceAgentRuns,
});

const workspaceAgentRunRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: '/agent-runs/$runId',
  component: WorkspaceAgentRun,
});

const workspaceSettingsRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: '/settings',
  component: WorkspaceSettings,
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  indexRoute,
  workspaceRoute.addChildren([
    workspaceIndexRoute,
    workspaceReposRoute,
    workspaceTeamsRoute,
    workspaceAnalyticsRoute,
    workspaceIntentRoute,
    workspaceAgentRunsRoute,
    workspaceAgentRunRoute,
    workspaceSettingsRoute,
  ]),
]);

export function createAppRouter(options: { history?: RouterHistory } = {}) {
  // retry: false — a failed request has already been through the api
  // client's own 401 refresh-then-redirect flow (src/api/client.ts); by the
  // time a query's queryFn rejects, retrying client-side buys nothing but
  // latency.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return createRouter({
    routeTree,
    context: { queryClient },
    // Router-wide defaults: each route resolves its own option ?? the router
    // default independently (a parent route's errorComponent is NOT inherited
    // by children), so setting them once here covers the whole tree.
    defaultErrorComponent: RouteErrorCard,
    defaultPendingComponent: DefaultRoutePending,
    ...(options.history ? { history: options.history } : {}),
  });
}

export const router = createAppRouter();

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
