import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

// One client for the explorer subtree. Scoped here (not app-root) because the
// rest of the desktop renderer uses zustand, not react-query. Exported so a
// zustand action that changes data a query caches can invalidate that cache —
// the two stores must not disagree about the same workspace row.
export const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 60_000, retry: 1, refetchOnWindowFocus: false } },
});

export function GraphQueryProvider({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
