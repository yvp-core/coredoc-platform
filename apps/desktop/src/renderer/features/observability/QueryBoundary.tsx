/**
 * Per-panel loading/error boundary over one query result — the same idiom as the
 * delivery view's `QueryBoundary`, kept as a local copy in this feature directory
 * (issue 02 scope is observability-only) rather than a cross-feature import.
 * Spinner while loading, message + Retry on error, otherwise `children(data)`.
 */

import type { ReactNode } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import { Button } from '../../components/ui/button';
import { Spinner } from '../../components/ui/spinner';

export function QueryBoundary<T>({ query, children }: { query: UseQueryResult<T>; children: (data: T) => ReactNode }) {
  if (query.isLoading) {
    return (
      <div className="flex min-h-[96px] items-center justify-center">
        <Spinner className="size-5 text-content-quaternary" />
      </div>
    );
  }
  if (query.isError) {
    return (
      <div className="flex min-h-[96px] flex-col items-center justify-center gap-2 text-center">
        <p className="text-xs text-content-secondary">Couldn't load this section.</p>
        <Button type="button" variant="outline" size="xs" onClick={() => void query.refetch()}>
          Retry
        </Button>
      </div>
    );
  }
  if (query.data === undefined) return null;
  return <>{children(query.data)}</>;
}
