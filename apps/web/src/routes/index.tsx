import { useNavigate } from '@tanstack/react-router';
import { useSuspenseQuery } from '@tanstack/react-query';
import { meQueryOptions } from '../api/queries/me.js';
import { RoleBadge } from '../components/role-badge.js';
import { Button } from '../components/ui/button.js';
import { BrandMark, useLogout } from './workspace.js';
import type { MeResponse } from '../api/types.js';

/** Pure decision: exactly one workspace means "skip the picker, go there". */
export function soleWorkspaceSlug(me: MeResponse): string | undefined {
  return me.workspaces.length === 1 ? me.workspaces[0]!.slug : undefined;
}

export function IndexPage() {
  const { data: me } = useSuspenseQuery(meQueryOptions);
  const navigate = useNavigate();
  const logout = useLogout();

  // Workspaces are not self-service from the web: membership comes from an
  // invite (or the operator's first-workspace bootstrap, docs/onprem/INSTALL.md §9).
  if (me.workspaces.length === 0) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-ground px-4">
        <div className="w-full max-w-sm rounded-xl border border-border bg-surface p-8 shadow-card">
          <div className="flex items-center justify-center gap-2.5">
            <BrandMark className="size-7 shrink-0" />
            <span className="text-[15px] font-medium tracking-[-0.01em]">CoreDoc</span>
          </div>
          <h1 className="mt-5 text-center text-[18px] font-medium tracking-[-0.02em]">No workspace access</h1>
          <p className="mt-2 text-center text-[13.5px] text-ink-3">
            You are signed in as <span className="text-ink-1">{me.user.email}</span>, but you are not a member of any
            workspace yet. Ask a workspace owner to invite you.
          </p>
          <Button type="button" variant="outline" size="sm" onClick={logout} className="mt-5 w-full">
            Log out
          </Button>
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-ground px-4 py-10">
      <div className="w-full max-w-md">
        <div className="flex items-center gap-2.5">
          <BrandMark className="size-7 shrink-0" />
          <h1 className="text-[18px] font-medium tracking-[-0.02em]">Choose a workspace</h1>
        </div>
        <ul className="mt-5 flex flex-col gap-2">
          {me.workspaces.map((workspace) => (
            <li key={workspace.id}>
              <button
                type="button"
                onClick={() => navigate({ to: '/w/$slug', params: { slug: workspace.slug } })}
                className="flex w-full items-center gap-3 rounded-xl border border-border bg-surface px-4 py-3 text-left shadow-card transition-colors hover:bg-surface-2"
              >
                <span
                  aria-hidden="true"
                  className="size-[15px] shrink-0 rounded-[5px]"
                  style={{ background: 'linear-gradient(135deg, var(--accent-a), var(--accent-b))' }}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] text-ink-1">{workspace.name}</span>
                  <span className="block truncate font-mono text-[12.5px] text-ink-4">{workspace.slug}</span>
                </span>
                <RoleBadge role={workspace.role} />
              </button>
            </li>
          ))}
        </ul>
      </div>
    </main>
  );
}
