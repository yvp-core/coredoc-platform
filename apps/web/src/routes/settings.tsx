import { useSuspenseQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';

import { meQueryOptions } from '@/api/queries/me';
import { PageHead } from '@/components/page-head';
import { RoleBadge } from '@/components/role-badge';
import { ThemeSelect } from '@/components/theme-toggle';
import { Card, CardBody, CardHead } from '@/components/ui/card';
import { DeliveryPanel } from '@/features/settings/DeliveryPanel';
import { GeneralPanel } from '@/features/settings/GeneralPanel';
import { hasAdminAccess } from '@/lib/roles';

import { findWorkspace } from './workspace';

export function WorkspaceSettings() {
  const { slug } = useParams({ strict: false });
  const { data: me } = useSuspenseQuery(meQueryOptions);

  const workspace = slug ? findWorkspace(me, slug) : undefined;
  // Unreachable in practice: the parent route redirects an unknown slug.
  if (!workspace) return null;

  const canManage = hasAdminAccess(workspace.role);

  return (
    <div className="flex flex-col gap-4">
      <PageHead
        title="Settings"
        sub={
          <>
            <span className="font-mono text-[11.5px]">{workspace.slug}</span>
            <RoleBadge role={workspace.role} />
          </>
        }
      />
      <GeneralPanel wsId={workspace.id} canManage={canManage} />
      <Card>
        <CardHead title="Appearance" sub="Applies to this browser only" />
        <CardBody className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-[12px] text-ink-3">System follows your operating system's light or dark preference.</p>
          <ThemeSelect />
        </CardBody>
      </Card>
      {/* Both delivery endpoints are admin-gated, so a member has nothing to read here. */}
      {canManage && <DeliveryPanel wsId={workspace.id} />}
    </div>
  );
}
