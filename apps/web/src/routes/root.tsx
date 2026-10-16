import { Outlet, useRouteContext } from '@tanstack/react-router';
import { QueryClientProvider } from '@tanstack/react-query';

// The QueryClient itself lives on router context (created once per
// createAppRouter() call — see router.tsx) so route loaders/beforeLoad
// guards and this provider share the exact same instance. Server state (the
// `me` query and everything that follows in later tasks) lives here, never
// in component state or a store (docs/web-ui-plan-2026-07.md §3.3: "no
// server data in stores" is the flagged desktop anti-pattern).
export function RootLayout() {
  const { queryClient } = useRouteContext({ from: '__root__' });
  return (
    <QueryClientProvider client={queryClient}>
      <Outlet />
    </QueryClientProvider>
  );
}
