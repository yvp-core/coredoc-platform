import { useCallback, useEffect, useMemo, useState } from 'react';
import { LinkCircle } from '@solar-icons/react';
import { Button } from '../../../../components/ui/button';
import { Spinner } from '../../../../components/ui/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../../../components/ui/tabs';
import { TeamMcpInviteStep, type ManualInviteLink } from '../../../../components/team-mcp/TeamMcpInviteStep';
import { TeamMcpConfigStep } from '../../../../components/team-mcp/TeamMcpConfigStep';
import { TeamMcpCiCdStep } from '../../../../components/team-mcp/TeamMcpCiCdStep';
import { TeamMcpReleaseTriggerStep } from '../../../../components/team-mcp/TeamMcpReleaseTriggerStep';
import { GraphQueryProvider } from '../../../../lib/graph-query-client';
import { UploadProgressDialog } from '../../../../components/UploadProgressDialog';
import { useAuthStore } from '../../../../stores/auth-store';
import { useWorkspaceStore } from '../../../../stores/workspace-store';
import { toast } from '../../../../hooks/use-toast';
import {
  isWorkspaceAdminRole,
  toWorkspaceMemberRole,
  WorkspaceMemberRole,
} from '../../../../types/workspace-member-role';

enum TeamMcpTab {
  Members = 'members',
  Config = 'mcp-config',
  CiCd = 'cicd',
}

export interface TeamMcpPanelProps {
  workspaceId: string;
}

/**
 * Docked "Team MCP Server" panel.
 *
 * The invite step's mutations resolve the workspace from the store's
 * `selectedWorkspaceId`, not from a prop. The modal this replaces got away with
 * that because its opener awaited `selectWorkspace` before setting `open`; a
 * docked panel has no such moment, so mount does the select and the body stays
 * behind a skeleton until the store agrees. That also closes a latent bug: if
 * the global selection drifts while the panel is open, the mutation controls
 * become unrenderable instead of silently targeting another workspace.
 */
export function TeamMcpPanel({ workspaceId }: TeamMcpPanelProps) {
  const [tab, setTab] = useState<TeamMcpTab>(TeamMcpTab.Members);
  const [chips, setChips] = useState<string[]>([]);
  const [inviteRole, setInviteRole] = useState<string>(WorkspaceMemberRole.Member);
  const [manualInviteLinks, setManualInviteLinks] = useState<ManualInviteLink[]>([]);
  const [enablingCiCd, setEnablingCiCd] = useState(false);

  const { members, workspaces, selectedWorkspaceId, selectWorkspace, setCiCdEnabled, inviteMember } =
    useWorkspaceStore();
  const { userId } = useAuthStore();

  useEffect(() => {
    void selectWorkspace(workspaceId);
  }, [workspaceId, selectWorkspace]);

  const workspace = useMemo(() => workspaces.find((w) => w.id === workspaceId), [workspaces, workspaceId]);
  const viewerRole = useMemo(
    () =>
      toWorkspaceMemberRole(workspace?.role) ?? toWorkspaceMemberRole(members.find((m) => m.userId === userId)?.role),
    [workspace?.role, members, userId],
  );
  const isAdminOrOwner = isWorkspaceAdminRole(viewerRole);

  /**
   * TeamMcpInviteStep is a controlled composer with no submit control of its
   * own — the Invite CTA has always been the host's job (it lived in the
   * deleted modal's DialogFooter). Without this the chip input is a control
   * that silently does nothing.
   */
  const handleInvite = useCallback(async () => {
    if (chips.length === 0) return;
    try {
      const manualLinks: ManualInviteLink[] = [];
      for (const email of chips) {
        const result = await inviteMember(email, inviteRole);
        if (!result.emailSent) {
          manualLinks.push({ email, signInUrl: result.signInUrl, expiresAt: result.expiresAt });
        }
      }
      setChips([]);
      setManualInviteLinks(manualLinks);
    } catch (err) {
      toast({ title: 'Invite failed', description: (err as Error).message, variant: 'destructive' });
    }
  }, [chips, inviteRole, inviteMember]);

  const handleEnableCiCd = async () => {
    setEnablingCiCd(true);
    try {
      await setCiCdEnabled(true);
      const upload = await window.electronAPI.workspaceUploadParsers(workspaceId);
      if (upload.errors.length > 0) {
        toast({
          title: 'Some parsers failed to upload',
          description: upload.errors.join('\n'),
          variant: 'destructive',
        });
      }
    } catch (err) {
      toast({ title: 'Could not enable CI/CD', description: (err as Error).message, variant: 'destructive' });
    } finally {
      setEnablingCiCd(false);
    }
  };

  const header = (
    <div className="flex items-center gap-2 px-4">
      {/* Outline, not Bold — the design pairs this heading with the same outline
          Link Circle the top bar's connect button carries (Figma `4841:18641`). */}
      <LinkCircle className="size-4 shrink-0 text-content-primary" />
      <h2 className="text-base font-bold leading-6 text-content-primary">Team MCP Server</h2>
    </div>
  );

  // The store still points elsewhere — every mutation below would target the
  // wrong workspace, so render nothing actionable.
  if (selectedWorkspaceId !== workspaceId) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-4">
        {header}
        <div className="flex flex-1 items-center justify-center gap-2 text-xs text-content-quaternary">
          <Spinner className="size-4" />
          Loading workspace…
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {header}

      <Tabs value={tab} onValueChange={(v) => setTab(v as TeamMcpTab)} className="flex min-h-0 flex-1 flex-col">
        <TabsList variant="underline" className="shrink-0 px-5">
          <TabsTrigger value={TeamMcpTab.Members}>Members</TabsTrigger>
          <TabsTrigger value={TeamMcpTab.Config}>MCP Config</TabsTrigger>
          {isAdminOrOwner && <TabsTrigger value={TeamMcpTab.CiCd}>CI/CD</TabsTrigger>}
        </TabsList>

        <TabsContent value={TeamMcpTab.Members} className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
          <TeamMcpInviteStep
            chips={chips}
            onChipsChange={setChips}
            inviteRole={inviteRole}
            onInviteRoleChange={setInviteRole}
            manualInviteLinks={manualInviteLinks}
            viewerWorkspaceRole={workspace?.role}
          />
          {/* Absent, not disabled. With no addressee there is nothing to submit, and a
              permanently greyed bar under the member list read as part of the list's
              chrome rather than as a control waiting on input. */}
          {chips.length > 0 && (
            <Button size="sm" className="mt-3 h-8 w-full rounded-lg" onClick={() => void handleInvite()}>
              {chips.length > 1 ? `Invite ${chips.length} people` : 'Invite'}
            </Button>
          )}
        </TabsContent>

        <TabsContent value={TeamMcpTab.Config} className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
          <TeamMcpConfigStep workspaceId={workspaceId} />
        </TabsContent>

        {isAdminOrOwner && (
          <TabsContent value={TeamMcpTab.CiCd} className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
            {workspace?.ciCdEnabled ? (
              <TeamMcpCiCdStep workspaceId={workspaceId} />
            ) : (
              <div className="flex flex-col gap-3 pt-2">
                <p className="text-xs leading-4 text-content-secondary">
                  Enable CI/CD to keep this workspace's graph in sync automatically from your pipeline.
                </p>
                <Button size="sm" className="h-8 w-fit rounded-lg" disabled={enablingCiCd} onClick={handleEnableCiCd}>
                  {enablingCiCd ? 'Enabling…' : 'Enable CI/CD'}
                </Button>
              </div>
            )}
            {/* Independent of the CI/CD graph sync above: a workspace can record
                releases from merges without pushing its graph from a pipeline. */}
            {/* The provider is the Intent panel's own client: changing the
                trigger here must invalidate the query the Releases header reads. */}
            <GraphQueryProvider>
              <TeamMcpReleaseTriggerStep workspaceId={workspaceId} />
            </GraphQueryProvider>
          </TabsContent>
        )}
      </Tabs>

      {/* Stays a modal on purpose: the upload must not be interrupted, and the
          panel is dismissible. */}
      <UploadProgressDialog
        open={enablingCiCd}
        title="Enabling CI/CD"
        description="Uploading extraction profiles to the cloud workspace. Keep the app open."
      />
    </div>
  );
}
