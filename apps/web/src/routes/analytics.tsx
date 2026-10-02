import { useSuspenseQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { meQueryOptions } from '@/api/queries/me';
import { PageHead } from '@/components/page-head';
import { RoleBadge } from '@/components/role-badge';
import { PillTabs } from '@/components/ui/pill-tabs';
import { DeliveryView } from '@/features/analytics/delivery/DeliveryView';
import { type AnalyticsWindow, AnalyticsWindowKind } from '@/features/analytics/types';
import { UsageView } from '@/features/analytics/usage/UsageView';
import { hasAdminAccess } from '@/lib/roles';
import { findWorkspace } from './workspace';

type AnalyticsView = 'usage' | 'delivery';

const VIEW_NOTE: Record<AnalyticsView, string> = {
  usage: 'MCP metrics + session OTLP · works without git/Jira integrations',
  delivery: 'needs delivery capture · coredoc-workflows plugin + GitHub/Jira connectors',
};

export function WorkspaceAnalytics() {
  const { slug } = useParams({ strict: false });
  const { data: me } = useSuspenseQuery(meQueryOptions);
  const workspace = findWorkspace(me, slug ?? '');

  const [view, setView] = useState<AnalyticsView>('usage');
  const [analyticsWindow, setAnalyticsWindow] = useState<AnalyticsWindow>({
    kind: AnalyticsWindowKind.Days,
    days: 30,
  });

  if (workspace === undefined) return null;
  const isTeam = hasAdminAccess(workspace.role);

  return (
    <div className="flex flex-col gap-3.5">
      <PageHead
        title="Workspace analytics"
        sub={
          <>
            <span className="font-mono">{workspace.slug}</span>
            <RoleBadge role={workspace.role} />
          </>
        }
      />

      <div className="flex flex-wrap items-center gap-3">
        <PillTabs
          value={view}
          onChange={setView}
          items={[
            { value: 'usage', label: 'Usage' },
            { value: 'delivery', label: 'Delivery' },
          ]}
        />
        <span className="text-[12.5px] text-ink-4">{VIEW_NOTE[view]}</span>
      </div>

      {view === 'usage' ? (
        <UsageView
          workspaceId={workspace.id}
          analyticsWindow={analyticsWindow}
          onWindowChange={setAnalyticsWindow}
          isTeam={isTeam}
        />
      ) : (
        <DeliveryView
          workspaceId={workspace.id}
          role={workspace.role}
          analyticsWindow={analyticsWindow}
          onWindowChange={setAnalyticsWindow}
        />
      )}
    </div>
  );
}
