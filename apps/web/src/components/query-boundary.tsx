import type { UseQueryResult } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { Button } from './ui/button';
import { Spinner } from './ui/spinner';

export function QueryBoundary<T>({ query, children }: { query: UseQueryResult<T>; children: (data: T) => ReactNode }) {
  if (query.isPending) {
    return (
      <div className="flex justify-center py-8">
        <Spinner className="text-ink-4" />
      </div>
    );
  }

  if (query.isError) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-surface px-4 py-3 shadow-card">
        <div className="min-w-0 text-[13.5px] text-danger-text">
          {query.error instanceof Error ? query.error.message : 'Request failed'}
        </div>
        <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  return <>{children(query.data)}</>;
}
