import { useEffect } from 'react';
import { useNavigate, getRouteApi } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { meQueryOptions } from '../api/queries/me.js';
import { buttonVariants } from '../components/ui/button.js';
import { cn } from '../lib/utils.js';
import { BrandMark } from './workspace.js';
import type { MeResponse } from '../api/types.js';

const route = getRouteApi('/login');

function buildLoginHref(returnTo: string): string {
  return `/api/v1/auth/web/login?returnTo=${encodeURIComponent(returnTo)}`;
}

// Public route. Deliberately fires NO network call: /api/v1/me is not
// exempt from the api client's 401→refresh→login-redirect flow, so an
// anonymous visitor's bootstrap fetch would hard-redirect them to the
// server login before they ever clicked "Sign in". Instead we only check
// the query CACHE — if a session was already resolved this visit (e.g. the
// user navigated back here in-app), bounce to `/`, which owns the
// workspace-count resolution; otherwise just render the sign-in card.
export function LoginPage() {
  const search = route.useSearch();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const hasSession = queryClient.getQueryData<MeResponse>(meQueryOptions.queryKey) !== undefined;

  useEffect(() => {
    if (hasSession) {
      navigate({ to: '/' });
    }
  }, [hasSession, navigate]);

  const returnTo = search.redirect ?? '/';

  return (
    <main className="flex min-h-screen items-center justify-center bg-ground px-4">
      <div className="w-full max-w-sm rounded-xl border border-border bg-surface p-8 shadow-card">
        <div className="flex items-center gap-2.5">
          <BrandMark className="size-7 shrink-0" />
          <h1 className="text-[14px] font-normal tracking-[-0.01em]">CoreDoc</h1>
        </div>
        <p className="mt-4 text-[12.5px] text-ink-3">Sign in to continue to your workspaces.</p>
        <a href={buildLoginHref(returnTo)} className={cn(buttonVariants(), 'mt-6 w-full')}>
          Sign in
        </a>
      </div>
    </main>
  );
}
