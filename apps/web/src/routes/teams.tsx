import { useSuspenseQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { useState } from 'react';

import { meQueryOptions } from '@/api/queries/me';
import { PageHead } from '@/components/page-head';
import { RoleBadge } from '@/components/role-badge';
import { PillTabs } from '@/components/ui/pill-tabs';
import { CiCdPanel } from '@/features/teams/CiCdPanel';
import { McpConfigPanel } from '@/features/teams/McpConfigPanel';
import { MembersPanel } from '@/features/teams/MembersPanel';
import { hasAdminAccess } from '@/lib/roles';

import { findWorkspace } from './workspace';

type Tab = 'members' | 'mcp' | 'cicd';

const TABS: { value: Tab; label: string }[] = [
  { value: 'members', label: 'Members' },
  { value: 'mcp', label: 'MCP config' },
  { value: 'cicd', label: 'CI/CD' },
];

export function WorkspaceTeams() {
  const { slug } = useParams({ strict: false });
  const { data: me } = useSuspenseQuery(meQueryOptions);
  const [tab, setTab] = useState<Tab>('members');

  const workspace = slug ? findWorkspace(me, slug) : undefined;
  // Unreachable in practice: the parent route redirects an unknown slug.
  if (!workspace) return null;

  const canManage = hasAdminAccess(workspace.role);

  return (
    <div className="flex flex-col gap-4">
      <PageHead
        title="Teams"
        sub={
          <>
            <span className="font-mono text-[12.5px]">{workspace.slug}</span>
            <RoleBadge role={workspace.role} />
          </>
        }
        right={<PillTabs<Tab> value={tab} onChange={setTab} items={TABS} />}
      />
      {tab === 'members' && <MembersPanel wsId={workspace.id} currentUserId={me.user.id} canManage={canManage} />}
      {tab === 'mcp' && <McpConfigPanel wsId={workspace.id} />}
      {tab === 'cicd' && (
        <CiCdPanel wsId={workspace.id} canManage={canManage} intentEnabled={workspace.intentEnabled} />
      )}
    </div>
  );
}
