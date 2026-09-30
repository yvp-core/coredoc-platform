import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { Link, Outlet, useNavigate, useParams } from '@tanstack/react-router';
import {
  BookMarked,
  BookOpen,
  ChartColumn,
  LayoutGrid,
  LogOut,
  Menu,
  Settings,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useState } from 'react';
import { request } from '../api/client.js';
import { meQueryOptions } from '../api/queries/me.js';
import { reposQueryOptions } from '../api/queries/repos.js';
import { workspaceConfigQueryOptions } from '../api/queries/workspace-config.js';
import type { MeResponse, Workspace } from '../api/types.js';
import { ThemeToggle } from '../components/theme-toggle.js';

/** Pure lookup so the redirect-on-unknown-slug decision is a plain function. */
export function findWorkspace(me: MeResponse, slug: string): Workspace | undefined {
  return me.workspaces.find((w) => w.slug === slug);
}

/**
 * Web-session logout. Shared with the index page. Only ends the Coredoc
 * session: the upstream IdP (WorkOS / GitHub) keeps its own session, so the
 * next "Sign in" may silently re-authenticate the same account.
 */
export function useLogout(): () => Promise<void> {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  return async () => {
    // Local logout must succeed even offline: server-side revocation is
    // best-effort, the cache clear + redirect below always runs.
    try {
      await request('/api/v1/auth/web/logout', { method: 'POST' });
    } catch {
      // Ignore — see above.
    }
    queryClient.clear();
    await navigate({ to: '/login' });
    // Observers still mounted during the first clear() refetch immediately
    // and can re-write the cache — wipe again now that nothing is subscribed.
    queryClient.clear();
  };
}

/** Brand mark. Shared with the login/index pages. */
export function BrandMark({ className }: { className?: string }) {
  // Same asset as apps/desktop/public/logo.svg, inlined so it ships as a
  // hashed build chunk (unhashed public/ files would get the 1y-immutable
  // cache policy in spa-serving.ts).
  return (
    <svg viewBox="0 0 96 106" fill="#1ACA92" aria-hidden="true" className={className}>
      <path d="M89.1195 27.395L62.8929 42.5201L15.5745 15.2231L41.8011 0.0794868L89.1195 27.395Z" />
      <path d="M95.7004 23.5953L89.1207 27.395L59.1211 12.5918H76.6331L95.7004 23.5953Z" />
      <path d="M7.19109 27.5697L33.4085 42.7133L33.4177 97.3259L7.18188 82.1915L7.19109 27.5697Z" />
      <path d="M0.611572 23.7609L7.19124 27.5698L9.37219 60.939L0.611572 45.777V23.7609Z" />
      <path d="M48.1699 98.3931L48.1791 68.1244L95.4883 40.8089V71.0868L48.1699 98.3931Z" />
      <path d="M48.1602 105.992L48.1694 98.3931L75.988 79.827L67.2366 94.989L48.1602 105.992Z" />
    </svg>
  );
}

/** "Dana Whitfield" → "DW"; falls back to the email's local part ("dana@…" → "DA"). */
function initials(user: { email: string; displayName?: string }): string {
  const name = user.displayName?.trim();
  if (name) {
    return name
      .split(/\s+/)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase() ?? '')
      .join('');
  }
  return user.email.slice(0, 2).toUpperCase();
}

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  exact?: boolean;
  badge?: 'repos' | 'members';
  /** Per-workspace feature gate; the item is hidden when it returns false. */
  gate?: (workspace: Workspace) => boolean;
}

const NAV: NavItem[] = [
  { to: '/w/$slug', label: 'Overview', icon: LayoutGrid, exact: true },
  { to: '/w/$slug/repos', label: 'Repositories', icon: BookMarked, badge: 'repos' },
  { to: '/w/$slug/teams', label: 'Teams', icon: Users, badge: 'members' },
  { to: '/w/$slug/analytics', label: 'Analytics', icon: ChartColumn },
  { to: '/w/$slug/intent', label: 'Intent', icon: BookOpen, gate: (w) => w.intentEnabled },
  { to: '/w/$slug/settings', label: 'Settings', icon: Settings },
];

function RailLink({
  item,
  slug,
  badge,
  onNavigate,
}: {
  item: NavItem;
  slug: string;
  badge?: number;
  onNavigate: () => void;
}) {
  const Icon = item.icon;
  return (
    <Link
      to={item.to}
      params={{ slug }}
      activeOptions={item.exact ? { exact: true } : undefined}
      onClick={onNavigate}
      className="block"
    >
      {({ isActive }) => (
        <span
          className={`flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-[12.5px] transition-colors ${
            isActive ? 'bg-brand-wash font-normal text-brand-text' : 'text-ink-2 hover:bg-surface-2 hover:text-ink-1'
          }`}
        >
          <Icon className="size-4 shrink-0" aria-hidden="true" />
          <span className="truncate">{item.label}</span>
          {badge !== undefined ? (
            <span className="num ml-auto rounded-full bg-surface-2 px-1.5 text-[10.5px] text-ink-4">{badge}</span>
          ) : null}
        </span>
      )}
    </Link>
  );
}

export function WorkspaceShell() {
  const { slug } = useParams({ from: '/w/$slug' });
  const { data: me } = useSuspenseQuery(meQueryOptions);
  const navigate = useNavigate();
  const [navOpen, setNavOpen] = useState(false);

  // Rail count badges ride queries the pages already issue, so this is
  // usually a cache hit. Unknown slug renders nothing — the guard redirects.
  const workspace = findWorkspace(me, slug);
  const wsId = workspace?.id;
  const nav = NAV.filter((item) => !item.gate || (workspace !== undefined && item.gate(workspace)));
  const { data: repos } = useQuery({ ...reposQueryOptions(wsId ?? ''), enabled: wsId !== undefined });
  const { data: config } = useQuery({ ...workspaceConfigQueryOptions(wsId ?? ''), enabled: wsId !== undefined });
  const badges: Record<NonNullable<NavItem['badge']>, number | undefined> = {
    repos: repos?.length,
    members: config?.members.length,
  };

  const handleLogout = useLogout();

  return (
    <div className="flex h-screen flex-col bg-ground text-ink-1">
      <header className="flex h-[52px] shrink-0 items-center gap-3 border-b border-border bg-surface px-4">
        <button
          type="button"
          aria-label={navOpen ? 'Close navigation' : 'Open navigation'}
          onClick={() => setNavOpen((open) => !open)}
          className="grid size-8 place-items-center rounded-lg border border-border bg-surface text-ink-3 md:hidden"
        >
          {navOpen ? <X className="size-3.5" /> : <Menu className="size-3.5" />}
        </button>

        <div className="flex items-center gap-2 pr-1">
          <BrandMark className="size-6 shrink-0" />
          <span className="text-[13.5px] font-normal tracking-[-0.01em]">CoreDoc</span>
        </div>

        <Select value={slug} onValueChange={(value) => navigate({ to: '/w/$slug', params: { slug: value } })}>
          <SelectTrigger aria-label="Workspace" className="max-w-[180px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {me.workspaces.map((workspace) => (
              <SelectItem key={workspace.id} value={workspace.slug}>
                {workspace.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="flex-1" />

        <ThemeToggle />
        <span
          title={me.user.email}
          aria-hidden="true"
          className="grid size-7 shrink-0 place-items-center rounded-full text-[11px] font-medium text-white"
          style={{ background: 'linear-gradient(135deg, var(--accent-a), var(--accent-b))' }}
        >
          {initials(me.user)}
        </span>
        <span className="hidden text-[12px] text-ink-3 lg:block">{me.user.email}</span>
        <button
          type="button"
          aria-label="Log out"
          title="Log out"
          onClick={handleLogout}
          className="grid size-8 place-items-center rounded-lg text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink-1"
        >
          <LogOut className="size-3.5" />
        </button>
      </header>

      <div className="relative flex min-h-0 flex-1">
        <nav
          aria-label="Workspace sections"
          className={`${navOpen ? 'absolute inset-y-0 left-0 z-30 flex bg-ground shadow-card' : 'hidden'} w-[220px] shrink-0 flex-col gap-0.5 overflow-y-auto p-3 md:static md:flex md:bg-ground md:shadow-none`}
        >
          {nav.map((item) => (
            <RailLink
              key={item.to}
              item={item}
              slug={slug}
              badge={item.badge ? badges[item.badge] : undefined}
              onNavigate={() => setNavOpen(false)}
            />
          ))}
        </nav>

        <main className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex max-w-[1400px] flex-col gap-4 p-6">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
