/**
 * `/w/$slug/intent` — the product intent knowledge base.
 *
 * Browse keeps its selection while delivery history is open. History links
 * focus the same item detail rather than creating a second intent catalogue.
 */

import { useSuspenseQuery } from '@tanstack/react-query';
import { getRouteApi, useParams } from '@tanstack/react-router';
import { useState } from 'react';

import { meQueryOptions } from '../api/queries/me.js';
import { EmptyNote } from '../components/empty-note.js';
import { PageHead } from '../components/page-head.js';
import { RoleBadge } from '../components/role-badge.js';
import { PillTabs } from '../components/ui/pill-tabs.js';
import type { IntentTreeSelection } from '../features/intent/intent-panel-state.js';
import { IntentPanel } from '../features/intent/panel.js';
import { ReleaseHistory } from '../features/intent/release-history.js';
import { findWorkspace } from './workspace.js';

const route = getRouteApi('/w/$slug/intent');

export function WorkspaceIntent() {
  const { slug } = useParams({ strict: false });
  const me = useSuspenseQuery(meQueryOptions).data;
  const workspace = slug ? findWorkspace(me, slug) : undefined;
  const search = route.useSearch();
  const selection: IntentTreeSelection = { domainId: search.domain ?? null, featureId: search.feature ?? null };
  const selectedItemId = search.item ?? null;
  const navigate = route.useNavigate();
  const onFocus = (next: IntentTreeSelection, itemId: string | null) =>
    navigate({
      search: {
        domain: next.domainId ?? undefined,
        feature: next.featureId ?? undefined,
        item: itemId ?? undefined,
      },
      replace: true,
    });
  const [tab, setTab] = useState<'browse' | 'releases'>('browse');

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
              { value: 'browse', label: 'Browse' },
              { value: 'releases', label: 'Delivery history' },
            ]}
          />
        }
      />
      <div hidden={tab === 'releases'}>
        <IntentPanel
          key={workspace.id}
          workspaceId={workspace.id}
          role={workspace.role}
          selection={selection}
          selectedItemId={selectedItemId}
          onFocus={onFocus}
        />
      </div>
      {tab === 'releases' && (
        <ReleaseHistory
          key={workspace.id}
          workspaceId={workspace.id}
          role={workspace.role}
          onOpenItem={(id) => {
            onFocus(selection, id);
            setTab('browse');
          }}
        />
      )}
    </>
  );
}
