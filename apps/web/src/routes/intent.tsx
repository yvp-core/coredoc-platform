/**
 * `/w/$slug/intent` — the product intent knowledge base.
 *
 * Browse keeps its selection while delivery history is open. History links
 * focus the same item detail rather than creating a second intent catalogue.
 */

import { useQuery, useSuspenseQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { useState } from 'react';

import { intentPendingReviewQueryOptions } from '../api/queries/intent.js';
import { meQueryOptions } from '../api/queries/me.js';
import { EmptyNote } from '../components/empty-note.js';
import { PageHead } from '../components/page-head.js';
import { RoleBadge } from '../components/role-badge.js';
import { PillTabs } from '../components/ui/pill-tabs.js';
import { IntentPanelTab } from '../features/intent/intent-panel-state.js';
import { IntentReleases } from '../features/intent/releases.js';
import { IntentPanel } from '../features/intent/panel.js';
import { findWorkspace } from './workspace.js';

export function WorkspaceIntent() {
  const { slug } = useParams({ strict: false });
  const me = useSuspenseQuery(meQueryOptions).data;
  const workspace = slug ? findWorkspace(me, slug) : undefined;
  const [focused, setFocused] = useState<{ workspaceId: string; itemId: string | null } | null>(null);
  const selectedItemId = focused?.workspaceId === workspace?.id ? (focused?.itemId ?? null) : null;
  const setSelectedItemId = (itemId: string | null) => setFocused({ workspaceId: workspace?.id ?? '', itemId });
  const [tab, setTab] = useState<IntentPanelTab | 'releases'>(IntentPanelTab.Browse);

  const pendingQuery = useQuery({
    ...intentPendingReviewQueryOptions(workspace?.id ?? ''),
    enabled: workspace !== undefined,
  });
  // Zero and unknown are deliberately the same answer here: the tab shows no
  // bubble for either, and a count flickering in from a failed read is worse.
  const waiting = pendingQuery.data?.waiting ?? 0;

  if (!workspace) return <EmptyNote>Workspace not found.</EmptyNote>;
  // The rail hides the tab; this stops a direct URL from rendering the surface.
  if (!workspace.intentEnabled) return <EmptyNote>Intent is not enabled for this workspace.</EmptyNote>;

  return (
    <>
      <PageHead
        title="Product intent"
        sub={
          <>
            <span className="font-mono">{workspace.slug}</span>
            <RoleBadge role={workspace.role} />
          </>
        }
        right={
          <PillTabs
            value={tab}
            onChange={setTab}
            items={[
              { value: IntentPanelTab.Browse, label: 'Browse' },
              { value: 'releases', label: 'Delivery history' },
              { value: IntentPanelTab.Review, label: 'Review', ...(waiting > 0 ? { count: waiting } : {}) },
            ]}
          />
        }
      />
      <div hidden={tab === 'releases'}>
        <IntentPanel
          key={workspace.id}
          workspaceId={workspace.id}
          role={workspace.role}
          tab={tab === 'releases' ? IntentPanelTab.Browse : tab}
          reviewerHandle={me.user.email}
          selectedItemId={selectedItemId}
          onSelectItem={setSelectedItemId}
        />
      </div>
      {tab === 'releases' && (
        <IntentReleases
          key={workspace.id}
          workspaceId={workspace.id}
          role={workspace.role}
          view="history"
          onOpenItem={(id) => {
            setSelectedItemId(id);
            setTab(IntentPanelTab.Browse);
          }}
        />
      )}
    </>
  );
}
