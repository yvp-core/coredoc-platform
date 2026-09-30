import type { ErrorComponentProps } from '@tanstack/react-router';
import { ApiError } from '../api/client.js';
import { Button } from '../components/ui/button.js';
import { Spinner } from '../components/ui/spinner.js';

// Router-wide `errorComponent`. Every route is wrapped in a CatchBoundary
// regardless of whether it declares one; without this the fallback is
// TanStack Router's bare default (an unstyled flash between screens).
export function RouteErrorCard({ error }: ErrorComponentProps) {
  const status = error instanceof ApiError ? error.status : undefined;
  const message = error instanceof Error ? error.message : 'Something went wrong.';

  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-xl border border-border bg-surface p-6 text-center shadow-card">
        <h2 className="text-[14px] font-medium text-ink-1">{status ? `Error ${status}` : 'Something went wrong'}</h2>
        <p className="mt-2 text-[12.5px] text-ink-3">{message}</p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-4"
          // Full page reload, deliberately NOT reset() + router.invalidate():
          // a hard refresh discards all client state, so recovery works even
          // when the error left the router or query cache wedged.
          onClick={() => window.location.reload()}
        >
          Reload
        </Button>
      </div>
    </div>
  );
}

/** Router-wide `pendingComponent`: a centered spinner while a route resolves. */
export function DefaultRoutePending() {
  return (
    <div data-testid="default-route-pending" className="flex min-h-[16rem] items-center justify-center">
      <Spinner className="size-5 text-ink-4" />
    </div>
  );
}
