/**
 * Analytics tab root: a Usage / Delivery view switch over server-aggregated
 * reads, with the shared time window.
 *
 * The two views own their own loading through `QueryBoundary`; the panel itself
 * issues no reads.
 */

import { useState } from 'react';
import { ChartSquare } from '@solar-icons/react';
import { AnalyticsWindowKind, type AnalyticsWindow } from '../../../shared/ipc-types.js';
import { Badge } from '../../components/ui/badge';
import { Tabs, TabsList, TabsTrigger } from '../../components/ui/tabs';
import { GraphQueryProvider } from '../../lib/graph-query-client';
import { ObservabilityUpsell } from './ObservabilityUpsell';
import { WindowSelector } from './WindowSelector';
import { DeliveryView } from './delivery/DeliveryView';
import { UsageView } from './usage/UsageView';

export interface AnalyticsPanelProps {
  workspaceId: string | null;
  role?: string;
}

type AnalyticsView = 'usage' | 'delivery';

function isTeamRole(role: string | undefined): boolean {
  return role === 'admin' || role === 'owner';
}

function ViewSwitch({ view, onChange }: { view: AnalyticsView; onChange: (view: AnalyticsView) => void }) {
  return (
    <Tabs value={view} onValueChange={(value) => onChange(value as AnalyticsView)}>
      <TabsList variant="pill">
        <TabsTrigger value="usage">Usage</TabsTrigger>
        <TabsTrigger value="delivery">Delivery</TabsTrigger>
      </TabsList>
    </Tabs>
  );
}

function AnalyticsPanelInner({ workspaceId, role }: AnalyticsPanelProps) {
  const [analyticsWindow, setAnalyticsWindow] = useState<AnalyticsWindow>({
    kind: AnalyticsWindowKind.Days,
    days: 30,
  });
  const [view, setView] = useState<AnalyticsView>('usage');
  const isTeam = isTeamRole(role);

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-xl border border-border shadow-[var(--shadow-panel)]">
      {/* The header wraps, the window selector inside it never does. */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-bg-1 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <ChartSquare weight="Bold" className="size-4 text-content-brand" />
          <Badge variant={isTeam ? 'info' : 'initial'}>{isTeam ? 'Team activity' : 'Your activity'}</Badge>
        </div>
        <div className="flex items-center gap-2">
          <ViewSwitch view={view} onChange={setView} />
          <WindowSelector value={analyticsWindow} onChange={setAnalyticsWindow} />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-4">
        <div className="flex flex-col gap-4">
          {view === 'usage' ? (
            <UsageView workspaceId={workspaceId!} window={analyticsWindow} isTeam={isTeam} />
          ) : (
            <DeliveryView workspaceId={workspaceId!} window={analyticsWindow} role={role} />
          )}
        </div>
      </div>
    </div>
  );
}

export function AnalyticsPanel(props: AnalyticsPanelProps) {
  if (props.workspaceId === null) return <ObservabilityUpsell />;
  return (
    <GraphQueryProvider>
      <AnalyticsPanelInner {...props} />
    </GraphQueryProvider>
  );
}
