import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { CheckCircle, DangerTriangle } from '@solar-icons/react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Badge } from './ui/badge';
import { Tabs, TabsList, TabsTrigger } from './ui/tabs';
import { useReviewStore, type ReviewFilter } from '../stores/review-store';
import { useProjectDetailStore, getReviewApproveLabel, type ReviewFlowNext } from '../stores/project-detail-store';
import { toast } from '../hooks/use-toast';
import { RegenerateDialog } from './RegenerateDialog';
import type {
  ReviewEntrypoint,
  ReviewEntity,
  ReviewExternalCall,
  ReviewStateStore,
  ReviewRoute,
} from '../../shared/ipc-types';

interface ReviewPanelProps {
  repoName: string;
  onRegenerate?: (feedback: string) => void;
  onApproved?: () => void;
  hideFooter?: boolean;
  flowNext?: ReviewFlowNext | null;
  onApproveAndNext?: () => void | Promise<void>;
}

interface TabDef {
  key: ReviewFilter;
  label: string;
}

const TABS: TabDef[] = [
  { key: 'entrypoints', label: 'Entry-points' },
  { key: 'entities', label: 'DB entities' },
  { key: 'externalCalls', label: 'External calls' },
  { key: 'stateStores', label: 'State stores' },
  { key: 'routes', label: 'Routes' },
];

export function ReviewPanel({
  repoName,
  onRegenerate,
  onApproved,
  hideFooter,
  flowNext,
  onApproveAndNext,
}: ReviewPanelProps) {
  const {
    graphData,
    approvalStatus,
    isLoading,
    filter,
    searchQuery,
    loadGraphData,
    loadApprovalStatus,
    approveParser,
    setFilter,
    setSearchQuery,
    reset,
  } = useReviewStore();

  const [regenerateOpen, setRegenerateOpen] = useState(false);
  const [approving, setApproving] = useState(false);

  // Get projectId from the active project detail store
  const projectId = useProjectDetailStore((s) => s.projectId);

  // Live-identity ref for async-handler reentry checks. useLayoutEffect runs
  // synchronously after commit (before paint), closing the post-commit /
  // pre-passive-effect microtask window where a promise continuation could
  // observe stale ref values. Render-time mutation is unsafe under concurrent
  // rendering — a discarded render could write the ref out of sync with UI.
  const liveIdentityRef = useRef({ projectId, repoName });
  useLayoutEffect(() => {
    liveIdentityRef.current = { projectId, repoName };
  }, [projectId, repoName]);

  // Mount status. useRef(false) initial is required: React 18 StrictMode runs
  // setup → cleanup → setup in dev. If we initialize true and only set false
  // in cleanup, StrictMode's cleanup permanently locks the ref to false.
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Synchronous double-click latch. setApproving schedules a render; until
  // React commits, `disabled={isApproving}` isn't on the DOM yet.
  const approvingRef = useRef(false);

  useEffect(() => {
    if (!projectId) return;
    loadGraphData(projectId, repoName);
    loadApprovalStatus(projectId, repoName);
    return () => reset();
  }, [projectId, repoName, loadGraphData, loadApprovalStatus, reset]);

  // Reload review data when underlying repo state changes (e.g. after re-parse)
  const repoState = useProjectDetailStore((s) => s.repoStates.get(repoName));
  const parsedTimestamp = repoState?.parsed.timestamp;
  const approvalStamp = repoState?.approval?.approvedAt;
  const prevParsedRef = useRef(parsedTimestamp);
  const prevApprovalRef = useRef(approvalStamp);

  useEffect(() => {
    if (!projectId) return;
    if (prevParsedRef.current !== undefined && parsedTimestamp !== prevParsedRef.current) {
      loadGraphData(projectId, repoName);
      loadApprovalStatus(projectId, repoName);
    }
    prevParsedRef.current = parsedTimestamp;
  }, [parsedTimestamp, projectId, repoName, loadGraphData, loadApprovalStatus]);

  useEffect(() => {
    if (!projectId) return;
    if (prevApprovalRef.current !== undefined && approvalStamp !== prevApprovalRef.current) {
      loadApprovalStatus(projectId, repoName);
    }
    prevApprovalRef.current = approvalStamp;
  }, [approvalStamp, projectId, repoName, loadApprovalStatus]);

  const counts = useMemo(() => {
    if (!graphData) return {} as Record<ReviewFilter, number>;
    return {
      entrypoints: graphData.entrypoints.length,
      entities: graphData.entities.length,
      externalCalls: graphData.externalCalls.length,
      stateStores: graphData.stateStores.length,
      routes: graphData.routes.length,
    };
  }, [graphData]);

  // Only show tabs that have data
  const visibleTabs = useMemo(() => TABS.filter((t) => (counts[t.key] ?? 0) > 0), [counts]);

  const handleApprove = async () => {
    if (approvingRef.current) return;
    if (!projectId) return;
    const projectIdAtClick = projectId;
    const repoNameAtClick = repoName;
    approvingRef.current = true;
    setApproving(true);
    try {
      const result = await approveParser(projectIdAtClick, repoNameAtClick);
      // approveParser returns `{ success: false }` on failure (does NOT throw)
      // — see review-store.ts. Bail before routing or we'd fire downstream
      // side effects (runBatchCommand) on a failed approval.
      if (!result.success) {
        toast({
          title: 'Approve failed',
          description: result.error ?? 'Could not save approval — try again.',
          variant: 'destructive',
        });
        return;
      }
      // Re-refresh the repo state ourselves. approveParser swallows refresh
      // failures as "Non-critical", so without this the parent's
      // onApproveAndNext can route off stale data and silently no-op
      // runBatchCommand(2).
      try {
        await useProjectDetailStore.getState().refreshRepoState(repoNameAtClick);
      } catch {
        toast({
          title: 'Approve saved, but refresh failed',
          description: 'Local state is stale — restart the app to recover.',
          variant: 'destructive',
        });
        return;
      }
      // Identity guards via refs (closure-trap-free):
      //   1. mountedRef — parent unmounted the panel.
      //   2. liveIdentityRef — parent kept the panel mounted but swapped to
      //      a different repo (e.g., user clicked another card mid-await).
      if (!mountedRef.current) return;
      const live = liveIdentityRef.current;
      if (live.projectId !== projectIdAtClick || live.repoName !== repoNameAtClick) return;

      if (onApproveAndNext) {
        await onApproveAndNext();
      } else {
        onApproved?.();
      }
    } finally {
      approvingRef.current = false;
      setApproving(false);
    }
  };

  const canApprove = approvalStatus?.outputMatchesParser !== false;
  const isApproved = approvalStatus?.approved && !approvalStatus.isStale;

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center bg-bg-primary pt-3 pr-1.5 rounded-t-xl shadow-foundation">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div
      className={`flex-1 flex flex-col min-h-0 bg-bg-primary pt-3.5 shadow-foundation ${
        hideFooter ? 'rounded-t-xl' : 'rounded-xl'
      }`}
    >
      {/* Header */}
      <div className="px-3 pb-3 overflow-hidden">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <h2 className="font-extrabold">{repoName}</h2>
            {isApproved && (
              <Badge variant="success" className="text-xs">
                <CheckCircle weight="Bold" className="h-3 w-3 text-content-tag-success" />
                Approved
              </Badge>
            )}
            {approvalStatus?.approved && approvalStatus.isStale && (
              <Badge variant="warning" className="text-xs">
                <DangerTriangle weight="Bold" className="h-3 w-3 text-content-tag-warning" />
                Stale
              </Badge>
            )}
            {approvalStatus && !approvalStatus.outputMatchesParser && (
              <Badge variant="destructive" className="text-xs">
                Re-parse required
              </Badge>
            )}
          </div>
        </div>

        {/* Search */}
        <div className="relative mb-4">
          <Input
            placeholder="Search entities"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-9 rounded-lg shadow-field text-sm"
          />
        </div>

        {/* Filter tabs */}
        <Tabs value={filter} onValueChange={(val) => setFilter(val as ReviewFilter)}>
          <TabsList variant="pill">
            {visibleTabs.map((tab) => (
              <TabsTrigger key={tab.key} value={tab.key}>
                {tab.label} {counts[tab.key] ?? 0}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>

      {/* Content — per-type view */}
      <div className="flex-1 overflow-auto px-3">
        {graphData && filter === 'entrypoints' && <EntrypointsView items={graphData.entrypoints} query={searchQuery} />}
        {graphData && filter === 'entities' && <EntitiesView items={graphData.entities} query={searchQuery} />}
        {graphData && filter === 'externalCalls' && (
          <ExternalCallsView items={graphData.externalCalls} query={searchQuery} />
        )}
        {graphData && filter === 'stateStores' && <StateStoresView items={graphData.stateStores} query={searchQuery} />}
        {graphData && filter === 'routes' && <RoutesView items={graphData.routes} query={searchQuery} />}
      </div>

      {!hideFooter && (
        <>
          {/* Footer */}
          <div className="-mx-1.5 px-5 py-3 bg-bg-overlay flex items-center justify-end gap-3 rounded-b-2xl shadow-foundation overflow-hidden">
            <Button variant="secondary" onClick={() => setRegenerateOpen(true)}>
              Re-parse Repository
            </Button>
            <Button variant="brand" onClick={handleApprove} disabled={!canApprove || approving || isApproved}>
              {approving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              {isApproved
                ? 'Approved'
                : flowNext
                  ? getReviewApproveLabel(flowNext, false)
                  : 'Approve & Update Knowledge Graph'}
            </Button>
          </div>

          <RegenerateDialog open={regenerateOpen} onOpenChange={setRegenerateOpen} onSubmit={onRegenerate!} />
        </>
      )}
    </div>
  );
}

// =============================================================================
// Shared
// =============================================================================

function Loc({ value }: { value: string }) {
  return <div className="mt-0.5 text-xs text-content-tertiary truncate">{value}</div>;
}

function Tag({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded-md text-xs bg-bg-tag-initial text-content-quaternary ${className ?? ''}`}
    >
      {children}
    </span>
  );
}

function EmptyState({ query }: { query: string }) {
  return (
    <div className="px-4 py-12 text-center text-muted-foreground text-xs">{query ? 'No matches' : 'None found'}</div>
  );
}

function matchesQuery(query: string, ...fields: (string | undefined)[]): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return fields.some((f) => f?.toLowerCase().includes(q));
}

// =============================================================================
// Entrypoints
// =============================================================================

function entrypointDetail(ep: ReviewEntrypoint): string {
  switch (ep.type) {
    case 'http':
      return `${ep.method} ${ep.fullPath}`;
    case 'queue':
      return [ep.system, ep.topic, ep.pattern].filter(Boolean).join(' / ');
    case 'graphql':
      return [ep.operationType, ep.parentType, ep.fieldName].filter(Boolean).join('.');
    case 'grpc':
      return [ep.serviceName, ep.methodName].filter(Boolean).join('.');
    case 'websocket':
      return [ep.namespace, ep.event].filter(Boolean).join('/');
    case 'cron':
      return ep.schedule ?? '';
    case 'event':
      return ep.eventName ?? '';
    case 'cli':
      return ep.command ?? '';
    default:
      return '';
  }
}

function entrypointProtocolTag(ep: ReviewEntrypoint): string {
  switch (ep.type) {
    case 'http':
      return 'https';
    case 'graphql':
      return 'graphql';
    case 'grpc':
      return 'grpc';
    case 'websocket':
      return 'ws';
    case 'queue':
      return ep.system ?? 'queue';
    case 'cron':
      return 'cron';
    case 'event':
      return 'event';
    case 'cli':
      return 'cli';
    default:
      return ep.type;
  }
}

// =============================================================================
// Entrypoints
// =============================================================================

function EntrypointsView({ items, query }: { items: ReviewEntrypoint[]; query: string }) {
  const filtered = useMemo(
    () => items.filter((ep) => matchesQuery(query, ep.location, ep.type, entrypointDetail(ep))),
    [items, query],
  );

  if (filtered.length === 0) return <EmptyState query={query} />;

  return (
    <div className="divide-y divide-border-input border-y border-border-input">
      {filtered.map((ep, i) => {
        const detail = entrypointDetail(ep);
        const isHttp = ep.type === 'http';
        return (
          <div key={ep.id || i} className="px-2 py-2 text-xs hover:bg-bg-overlay/50">
            <div className="flex items-center gap-2">
              {isHttp && ep.method && <span className="text-sm text-content-primary uppercase">{ep.method}</span>}
              <span className="text-sm text-content-primary truncate">{isHttp ? ep.fullPath : detail}</span>
              <Tag>{entrypointProtocolTag(ep)}</Tag>
            </div>
            <Loc value={ep.location} />
          </div>
        );
      })}
    </div>
  );
}

// =============================================================================
// Entities
// =============================================================================

function EntitiesView({ items, query }: { items: ReviewEntity[]; query: string }) {
  const filtered = useMemo(
    () => items.filter((e) => matchesQuery(query, e.name, e.tableName, e.location, e.ormType)),
    [items, query],
  );

  if (filtered.length === 0) return <EmptyState query={query} />;

  return (
    <div className="divide-y divide-border-input border-y border-border-input">
      {filtered.map((entity, i) => (
        <div key={entity.id || i} className="px-2 py-2.5 text-xs hover:bg-bg-overlay/50 space-y-1">
          {/* Header */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm text-content-primary">{entity.name}</span>
            {entity.tableName && <span className="text-sm text-content-tertiary">{entity.tableName}</span>}
            {entity.ormType && <span className="text-sm text-content-tertiary">{entity.ormType}</span>}
          </div>
          <Loc value={entity.location} />

          {/* Fields */}
          {entity.fields.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1.5">
              {entity.fields.map((f) => (
                <span
                  key={f.name}
                  className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-xs  ${
                    f.isPrimaryKey ? 'bg-lavender-magenta-100' : 'bg-bg-tag-initial'
                  }`}
                >
                  {f.isPrimaryKey && <span className="text-lavender-magenta-400">PK</span>}
                  <span className="text-content-tertiary">{f.columnName || f.name}</span>
                  {f.type && <span className="text-content-quaternary">{f.type}</span>}
                </span>
              ))}
            </div>
          )}

          {/* Relations */}
          {entity.relations.length > 0 && (
            <div className="flex flex-wrap gap-x-2 gap-y-0.5 mt-0.5">
              {entity.relations.map((r) => (
                <span key={r.name} className="text-xs text-green-600">
                  {r.type} <span className="font-medium">{r.targetEntityName}</span>
                </span>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// =============================================================================
// External Calls
// =============================================================================

function externalCallTarget(td: NonNullable<ReviewExternalCall['targetDescriptor']>): string {
  if (td.http) return td.targetService ?? td.http.pathTemplate;
  if (td.messaging) return td.messaging.destinationValue ?? td.messaging.destination;
  if (td.grpc) return `${td.grpc.service}.${td.grpc.method}`;
  if (td.graphql) return td.graphql.operationName;
  return td.targetService ?? '';
}

function ExternalCallsView({ items, query }: { items: ReviewExternalCall[]; query: string }) {
  const filtered = useMemo(
    () =>
      items.filter((ec) =>
        matchesQuery(
          query,
          ec.serviceName,
          ec.method,
          ec.location,
          ec.targetDescriptor?.protocol,
          ec.targetDescriptor?.targetService,
          ec.targetDescriptor?.http?.pathTemplate,
          ec.targetDescriptor?.messaging?.destinationValue,
          ec.targetDescriptor?.messaging?.destination,
        ),
      ),
    [items, query],
  );

  if (filtered.length === 0) return <EmptyState query={query} />;

  return (
    <div className="divide-y divide-border-input border-y border-border-input">
      {filtered.map((ec, i) => {
        const target = ec.targetDescriptor ? externalCallTarget(ec.targetDescriptor) : '';
        const protocol = ec.targetDescriptor?.protocol;
        return (
          <div key={ec.id || i} className="px-2 py-2 text-xs hover:bg-bg-overlay/50">
            <div className="flex items-center gap-2 flex-wrap mb-1">
              <span className="text-sm text-content-primary">{ec.serviceName}</span>
              <span className="text-sm text-content-tertiary">{ec.method}</span>
              {protocol && <Tag>{protocol}</Tag>}
            </div>
            <div className="gap-0.5">
              {target && <div className="mt-0.5 text-xs text-content-tertiary">→ {target}</div>}
              <Loc value={ec.location} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// =============================================================================
// State Stores (frontend)
// =============================================================================

function StateStoresView({ items, query }: { items: ReviewStateStore[]; query: string }) {
  const filtered = useMemo(
    () => items.filter((s) => matchesQuery(query, s.name, s.library, s.location)),
    [items, query],
  );

  if (filtered.length === 0) return <EmptyState query={query} />;

  return (
    <div className="divide-y divide-border-input border-y border-border-input">
      {filtered.map((store, i) => (
        <div key={store.id || i} className="px-2 py-2 text-xs hover:bg-bg-overlay/50">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-sm text-content-primary truncate">{store.name}</span>
            {store.library && <Tag>{store.library}</Tag>}
          </div>
          <Loc value={store.location} />
        </div>
      ))}
    </div>
  );
}

// =============================================================================
// Routes (frontend)
// =============================================================================

function RoutesView({ items, query }: { items: ReviewRoute[]; query: string }) {
  const filtered = useMemo(
    () => items.filter((r) => matchesQuery(query, r.path, r.componentName, r.location)),
    [items, query],
  );

  if (filtered.length === 0) return <EmptyState query={query} />;

  return (
    <div className="divide-y divide-border-input border-y border-border-input">
      {filtered.map((route, i) => (
        <div key={route.id || i} className="px-2 py-2 text-xs hover:bg-bg-overlay/50">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-sm text-content-primary truncate">{route.path}</span>
            {route.componentName && (
              <>
                <span className="text-content-quaternary">→</span>
                <span className="text-sm text-content-secondary truncate">{route.componentName}</span>
              </>
            )}
          </div>
          <Loc value={route.location} />
        </div>
      ))}
    </div>
  );
}
