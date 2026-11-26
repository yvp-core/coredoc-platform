import { useQuery, useSuspenseQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { ChevronLeft, LogOut, TriangleAlert } from 'lucide-react';
import { useEffect, useRef } from 'react';

import { ApiError } from '@/api/client';
import {
  CONSULTANT_RUN_LIST_LIMIT,
  type ConsultantRunList,
  type ConsultantRunQuestions,
  consultantRunQuestionsQueryOptions,
  consultantRunsQueryOptions,
} from '@/api/queries/consultant-runs';
import { meQueryOptions } from '@/api/queries/me';
import type { Workspace } from '@/api/types';
import { EmptyNote } from '@/components/empty-note';
import { QueryBoundary } from '@/components/query-boundary';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { QuestionRecord, When } from '@/features/consultant/QuestionRecord';
import { hasAdminAccess } from '@/lib/roles';

import { BrandMark, findWorkspace, useLogout } from './workspace';

const UNTITLED = 'Untitled run';

function isStatus(error: unknown, status: number): boolean {
  return error instanceof ApiError && error.status === status;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? `1 ${one}` : `${n} ${many}`;
}

function RunBadge({ open, unanswered }: { open: number; unanswered: number }) {
  if (open > 0) {
    return (
      <Badge variant="warn">
        <span aria-hidden="true">{open} waiting</span>
        <span className="sr-only">{plural(open, 'question waits', 'questions wait')} for an answer</span>
      </Badge>
    );
  }
  if (unanswered > 0) {
    return (
      <Badge variant="err">
        <span aria-hidden="true">{unanswered} unanswered</span>
        <span className="sr-only">{plural(unanswered, 'question was', 'questions were')} closed without an answer</span>
      </Badge>
    );
  }
  return null;
}

function RunsPanel({
  slug,
  list,
  selected,
  offset,
}: {
  slug: string;
  list: ConsultantRunList;
  selected: string | undefined;
  offset: number;
}) {
  const navigate = useNavigate();
  const page = (next: number) =>
    navigate({ to: '/consultant/$slug', params: { slug }, search: (prev) => ({ ...prev, offset: next || undefined }) });

  return (
    <>
      {list.runs.length === 0 ? (
        <EmptyNote>{offset === 0 ? 'No runs yet.' : 'No older runs.'}</EmptyNote>
      ) : (
        <ul className="flex flex-col gap-0.5 px-2">
          {list.runs.map((run) => {
            const current = run.id === selected;
            return (
              <li key={run.id}>
                <Link
                  to="/consultant/$slug"
                  params={{ slug }}
                  search={{ run: run.id, offset: offset || undefined }}
                  aria-current={current ? 'page' : undefined}
                  className={`flex flex-col gap-0.5 rounded-lg px-2.5 py-2 transition-colors ${
                    current ? 'bg-brand-wash text-brand-text' : 'text-ink-2 hover:bg-surface-2'
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-[13.5px] text-ink-1">{run.name ?? UNTITLED}</span>
                    <RunBadge open={run.openQuestions} unanswered={run.unansweredQuestions} />
                  </span>
                  <span className="text-[12.5px] text-ink-4">
                    Updated <When iso={run.updatedAt} />
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {(offset > 0 || list.nextOffset !== null) && (
        <div className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t border-border-soft px-4 py-3">
          <span aria-live="polite" className="num text-[12.5px] text-ink-4">
            {list.runs.length > 0 ? `Runs ${offset + 1}–${offset + list.runs.length}` : ''}
          </span>
          <span className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={offset === 0}
              onClick={() => page(Math.max(0, offset - CONSULTANT_RUN_LIST_LIMIT))}
            >
              Newer
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={list.nextOffset === null}
              onClick={() => list.nextOffset !== null && page(list.nextOffset)}
            >
              Older
            </Button>
          </span>
        </div>
      )}
    </>
  );
}

function RunView({ data }: { data: ConsultantRunQuestions }) {
  const heading = useRef<HTMLHeadingElement>(null);
  const runId = data.run.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: focus moves only when another run is selected.
  useEffect(() => {
    heading.current?.focus();
  }, [runId]);

  const open = data.records.filter((record) => record.state === 'open');
  const unanswered = data.records.filter((record) => record.state === 'cancelled').length;

  return (
    <>
      <div className="min-w-0">
        <div className="text-[12px] uppercase tracking-[0.06em] text-ink-4">Coredoc Cloud</div>
        <h1
          ref={heading}
          tabIndex={-1}
          className="mt-0.5 break-words text-[22px] font-medium leading-tight tracking-[-0.02em] text-ink-1"
        >
          {data.run.name ?? UNTITLED}
        </h1>
        <div className="mt-[3px] text-[13.5px] text-ink-3">
          Started <When iso={data.run.createdAt} />
        </div>
      </div>
      {data.records.length === 0 ? (
        <EmptyNote>No questions on this run yet.</EmptyNote>
      ) : (
        <>
          {open.length > 0 ? (
            <a href={`#q-${open[0]!.requestId}`} className="text-[13.5px] text-ink-2 hover:underline">
              {plural(open.length, 'question waits', 'questions wait')} for an answer
            </a>
          ) : unanswered > 0 ? (
            <p className="flex items-center gap-1.5 text-[13.5px] text-danger-text">
              <TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" />
              {plural(unanswered, 'question was', 'questions were')} closed without an answer
            </p>
          ) : (
            <p className="text-[13.5px] text-ink-2">No open questions</p>
          )}
          {data.records.map((record) => (
            <QuestionRecord key={record.requestId} record={record} />
          ))}
        </>
      )}
    </>
  );
}

function NoAccess({ email, workspaceName }: { email: string; workspaceName: string }) {
  const logout = useLogout();
  return (
    <main className="flex min-h-screen items-center justify-center bg-ground px-4">
      <div className="w-full max-w-sm rounded-xl border border-border bg-surface p-8 shadow-card">
        <div className="flex items-center justify-center gap-2.5">
          <BrandMark className="size-7 shrink-0" />
          <span className="text-[15px] font-medium tracking-[-0.01em]">CoreDoc</span>
        </div>
        <h1 className="mt-5 text-center text-[18px] font-medium tracking-[-0.02em]">No access to this page</h1>
        <p className="mt-2 text-center text-[13.5px] text-ink-3">
          You are signed in as <span className="text-ink-1">{email}</span>, but your access to {workspaceName} has
          changed. Reload to see what you can open now, or ask a workspace admin.
        </p>
        <div className="mt-5 flex gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => window.location.reload()} className="flex-1">
            Reload
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={logout} className="flex-1">
            Log out
          </Button>
        </div>
      </div>
    </main>
  );
}

function ConsultantLayout({ workspace, email }: { workspace: Workspace; email: string }) {
  const { slug } = useParams({ from: '/consultant/$slug' });
  const { run, offset = 0 } = useSearch({ from: '/consultant/$slug' });
  const logout = useLogout();
  const runs = useQuery(consultantRunsQueryOptions(workspace.id, offset));
  const questions = useQuery({
    ...consultantRunQuestionsQueryOptions(workspace.id, run ?? ''),
    enabled: run !== undefined,
  });

  if (isStatus(runs.error, 403) || isStatus(questions.error, 403)) {
    return <NoAccess email={email} workspaceName={workspace.name} />;
  }

  return (
    <div className="flex h-screen flex-col bg-ground text-ink-1">
      <header className="flex h-[52px] shrink-0 items-center gap-3 border-b border-border bg-surface px-4">
        <div className="flex items-center gap-2 pr-1">
          <BrandMark className="size-6 shrink-0" />
          <span className="text-[14.5px] font-medium tracking-[-0.01em]">CoreDoc</span>
        </div>
        <span className="truncate text-[13.5px] text-ink-2">{workspace.name}</span>
        <div className="flex-1" />
        <span className="hidden max-w-[240px] truncate text-[13px] text-ink-3 sm:block">{email}</span>
        <button
          type="button"
          aria-label="Log out"
          title="Log out"
          onClick={logout}
          className="grid size-8 shrink-0 place-items-center rounded-lg text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink-1"
        >
          <LogOut className="size-3.5" />
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        <nav
          aria-label="Runs"
          className={`${run ? 'hidden md:flex' : 'flex'} w-full shrink-0 flex-col overflow-y-auto border-r border-border bg-surface md:w-[300px]`}
        >
          <div className="px-4 pt-4 pb-2 text-[11.5px] uppercase tracking-[0.04em] text-ink-4">Runs</div>
          <div className="flex min-h-0 flex-1 flex-col">
            <QueryBoundary query={runs}>
              {(list) => <RunsPanel slug={slug} list={list} selected={run} offset={offset} />}
            </QueryBoundary>
          </div>
        </nav>

        <main className={`${run ? 'flex' : 'hidden md:flex'} min-w-0 flex-1 overflow-y-auto`}>
          <div className="mx-auto flex w-full max-w-[80ch] flex-col gap-4 p-4 sm:p-6">
            {run && (
              <Link
                to="/consultant/$slug"
                params={{ slug }}
                search={{ offset: offset || undefined }}
                className="inline-flex items-center gap-1 text-[13px] text-ink-3 hover:text-ink-1 md:hidden"
              >
                <ChevronLeft className="size-3.5" aria-hidden="true" />
                All runs
              </Link>
            )}
            {hasAdminAccess(workspace.role) && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-blue-wash px-3 py-2 text-[13px] text-blue">
                <span>Preview: this is what consultants see in this workspace.</span>
                <Link to="/w/$slug" params={{ slug }} className="underline">
                  Back to the workspace
                </Link>
              </div>
            )}
            {!run ? (
              <>
                <h1 className="text-[22px] font-medium leading-tight tracking-[-0.02em] text-ink-1">Runs</h1>
                <EmptyNote>Choose a run to see its questions.</EmptyNote>
              </>
            ) : isStatus(questions.error, 404) ? (
              <>
                <h1 className="text-[22px] font-medium leading-tight tracking-[-0.02em] text-ink-1">Runs</h1>
                <EmptyNote>This run is not available. Choose another run from the list.</EmptyNote>
              </>
            ) : (
              <QueryBoundary query={questions}>{(data) => <RunView data={data} />}</QueryBoundary>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

export function ConsultantPage() {
  const { slug } = useParams({ from: '/consultant/$slug' });
  const { data: me } = useSuspenseQuery(meQueryOptions);
  const workspace = findWorkspace(me, slug);
  // Unreachable in practice: the route guard redirects an unknown slug.
  if (!workspace) return null;
  return <ConsultantLayout workspace={workspace} email={me.user.email} />;
}
