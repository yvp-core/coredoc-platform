import { useCallback, useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogBody, DialogTitle, DialogFooter } from './ui/dialog';
import { Button } from './ui/button';
import { useWorkspaceStore } from '../stores/workspace-store';
import { useProjectsStore } from '../stores/projects-store';
import { TeamMcpInviteStep, type ManualInviteLink } from './team-mcp/TeamMcpInviteStep';
import { TeamMcpConfigStep } from './team-mcp/TeamMcpConfigStep';
import { TeamMcpCiCdStep } from './team-mcp/TeamMcpCiCdStep';
import { UploadProgressDialog } from './UploadProgressDialog';
import { toast } from '../hooks/use-toast';
import type { Project } from '../types/project';

type WizardState = 'info' | 'uploading' | 'error' | 'invite' | 'mcp-config' | 'ci-cd';

interface ConnectTeamMcpWizardProps {
  open: boolean;
  onClose: () => void;
  project: Project;
}

function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function ConnectTeamMcpWizard({ open, onClose, project }: ConnectTeamMcpWizardProps) {
  const [state, setState] = useState<WizardState>('info');
  const [ciCdChecked, setCiCdChecked] = useState(false);
  // Seed from on-disk project.cloud so reopens after an interrupted upload
  // reuse the existing workspace instead of creating a duplicate. The wizard
  // will only call createWorkspace when this is still null at upload time.
  const [workspaceId, setWorkspaceId] = useState<string | null>(project.cloud?.workspaceId ?? null);
  const [error, setError] = useState<string | null>(null);
  const [inviteChips, setInviteChips] = useState<string[]>([]);
  const [inviteRole, setInviteRole] = useState('member');
  const [manualInviteLinks, setManualInviteLinks] = useState<ManualInviteLink[]>([]);

  const { createWorkspace, selectWorkspace, syncToCloud, inviteMember, loadWorkspaces, workspaces } =
    useWorkspaceStore();
  const { setProjectCloud } = useProjectsStore();

  // Authoritative viewer role, same source TeamMcpPanel uses. `runUpload` awaits
  // both loadWorkspaces and selectWorkspace before the invite step renders, so
  // the workspace is in the store by the time this is read.
  const viewerWorkspaceRole = workspaces.find((w) => w.id === workspaceId)?.role;

  const total = 2 + (ciCdChecked ? 1 : 0);

  const resetWizard = useCallback(() => {
    setState('info');
    setCiCdChecked(false);
    // Don't clobber an existing cloud link on close — the workspace exists
    // server-side regardless of UI state. Reset to the on-disk value so the
    // next open reflects truth.
    setWorkspaceId(project.cloud?.workspaceId ?? null);
    setError(null);
    setInviteChips([]);
    setInviteRole('member');
    setManualInviteLinks([]);
  }, [project.cloud?.workspaceId]);

  useEffect(() => {
    if (!open) {
      resetWizard();
    }
  }, [open, resetWizard]);

  const runUpload = useCallback(async () => {
    setState('uploading');
    setError(null);
    try {
      let wsId = workspaceId;
      if (!wsId) {
        const ws = await createWorkspace(project.name.trim(), slugify(project.name));
        wsId = ws.id;
        setWorkspaceId(wsId);
        // Persist the workspace link to disk BEFORE the heavy steps
        // (enableCloud / syncToCloud / uploadParsers). If the app crashes or
        // the user closes mid-flow, the next launch sees this and reuses the
        // workspace instead of creating a fresh duplicate every time.
        await setProjectCloud(project.id, { enabled: true, workspaceId: wsId });
      }
      await window.electronAPI.workspaceEnableCloud(wsId, { ciCdEnabled: ciCdChecked });
      const syncResult = await syncToCloud(
        wsId,
        {
          id: project.id,
          name: project.name,
          repos: project.repositories.map((r) => ({ name: r.name, path: r.path, httpPrefix: r.httpPrefix })),
        },
        true,
      );
      if (syncResult.errors.length > 0) {
        throw new Error(syncResult.errors.map((e) => `${e.repoName}: ${e.error}`).join('\n'));
      }

      // workspaceUploadParsers resolves the local project via
      // config.projects.find(p => p.cloud?.workspaceId === wsId) — the cloud
      // link was already written to disk immediately after createWorkspace
      // above, so that lookup will succeed here.

      if (ciCdChecked) {
        const upload = await window.electronAPI.workspaceUploadParsers(wsId);
        if (upload.errors.length > 0) {
          throw new Error(upload.errors.join('\n'));
        }
      }

      await setProjectCloud(project.id, {
        enabled: true,
        workspaceId: wsId,
        lastSyncedAt: new Date().toISOString(),
      });
      await loadWorkspaces();
      await selectWorkspace(wsId);
      setState('invite');
    } catch (err) {
      setError((err as Error).message);
      setState('error');
    }
  }, [
    workspaceId,
    ciCdChecked,
    project,
    createWorkspace,
    selectWorkspace,
    syncToCloud,
    setProjectCloud,
    loadWorkspaces,
  ]);

  const handleInviteNext = async () => {
    if (inviteChips.length > 0) {
      try {
        const manualLinks: ManualInviteLink[] = [];
        for (const email of inviteChips) {
          const result = await inviteMember(email, inviteRole);
          if (!result.emailSent) {
            manualLinks.push({ email, signInUrl: result.signInUrl, expiresAt: result.expiresAt });
          }
        }
        setInviteChips([]);
        if (manualLinks.length > 0) {
          setManualInviteLinks(manualLinks);
          return;
        }
      } catch (err) {
        toast({
          title: 'Invite failed',
          description: (err as Error).message,
          variant: 'destructive',
        });
        return; // do NOT advance; let user retry or skip
      }
    }
    setState('mcp-config');
  };
  const handleMcpBack = () => setState('invite');
  const handleMcpNext = () => (ciCdChecked ? setState('ci-cd') : onClose());
  const handleCiCdBack = () => setState('mcp-config');
  const handleFinish = () => onClose();

  return (
    <>
      <UploadProgressDialog
        open={open && state === 'uploading'}
        title="Uploading your graph to cloud"
        description="Please keep the app open until the upload is complete. Closing now will interrupt the process and you'll need to start over."
      />
      <Dialog
        open={open && state !== 'uploading'}
        onOpenChange={(isOpen) => {
          if (!isOpen) onClose();
        }}
      >
        <DialogContent className="sm:max-w-[640px]" showCloseButton={false}>
          {state === 'info' && (
            <>
              <DialogHeader>
                <DialogTitle>Upload graph to cloud</DialogTitle>
              </DialogHeader>
              <DialogBody className="text-sm text-content-tertiary font-medium">
                Your local graph will be hosted on CoreDoc cloud. Once uploaded, every connected team member and AI
                agent works with the same system context — same architecture, same dependencies
                {ciCdChecked ? ', same generated docs' : ''}.
                <label className="mt-4 flex items-center gap-2 text-sm text-content-primary cursor-pointer">
                  <input
                    type="checkbox"
                    checked={ciCdChecked}
                    onChange={(e) => setCiCdChecked(e.target.checked)}
                    className="size-4"
                  />
                  Keep graph in sync automatically via CI/CD pipeline
                </label>
              </DialogBody>
              <DialogFooter>
                <Button variant="secondary" onClick={onClose}>
                  Cancel
                </Button>
                <Button variant="default" onClick={runUpload}>
                  Upload
                </Button>
              </DialogFooter>
            </>
          )}

          {state === 'error' && (
            <>
              <DialogHeader>
                <DialogTitle>Upload failed</DialogTitle>
              </DialogHeader>
              <DialogBody>
                <div className="px-3 py-2 rounded-md bg-red-500/10 text-sm text-red-400">{error}</div>
              </DialogBody>
              <DialogFooter>
                <Button variant="secondary" onClick={onClose}>
                  Cancel
                </Button>
                <Button variant="default" onClick={runUpload}>
                  Retry
                </Button>
              </DialogFooter>
            </>
          )}

          {state === 'invite' && workspaceId && (
            <>
              <DialogHeader className="flex-row items-center justify-between">
                <DialogTitle>Invite your team</DialogTitle>
                <span className="text-xs text-content-tertiary">Step 1/{total}</span>
              </DialogHeader>
              <DialogBody className="overflow-y-auto max-h-[60vh]">
                <p className="text-sm text-content-tertiary">
                  Add team members to give them access to the shared graph.
                </p>
                <TeamMcpInviteStep
                  chips={inviteChips}
                  onChipsChange={setInviteChips}
                  inviteRole={inviteRole}
                  onInviteRoleChange={setInviteRole}
                  manualInviteLinks={manualInviteLinks}
                  viewerWorkspaceRole={viewerWorkspaceRole}
                />
              </DialogBody>
              <DialogFooter>
                <Button variant="secondary" onClick={onClose}>
                  Cancel
                </Button>
                <Button variant="default" onClick={handleInviteNext}>
                  {inviteChips.length === 0
                    ? manualInviteLinks.length > 0
                      ? 'Continue'
                      : 'Skip this step'
                    : 'Invite & Go Next'}
                </Button>
              </DialogFooter>
            </>
          )}

          {state === 'mcp-config' && workspaceId && (
            <>
              <DialogHeader className="flex-row items-center justify-between">
                <DialogTitle>Connect Team MCP</DialogTitle>
                <span className="text-xs text-content-tertiary">Step 2/{total}</span>
              </DialogHeader>
              <DialogBody className="overflow-y-auto max-h-[60vh]">
                <p className="text-sm text-content-tertiary">Add this MCP server to your AI client.</p>
                <TeamMcpConfigStep workspaceId={workspaceId} />
              </DialogBody>
              <DialogFooter className="justify-between">
                <Button variant="ghost" onClick={handleMcpBack}>
                  Back
                </Button>
                <Button variant="default" onClick={handleMcpNext}>
                  {ciCdChecked ? 'Next' : 'Finish setup'}
                </Button>
              </DialogFooter>
            </>
          )}

          {state === 'ci-cd' && workspaceId && (
            <>
              <DialogHeader className="flex-row items-center justify-between">
                <DialogTitle>Set up CI/CD</DialogTitle>
                <span className="text-xs text-content-tertiary">Step 3/{total}</span>
              </DialogHeader>
              <DialogBody className="overflow-y-auto max-h-[60vh]">
                <p className="text-sm text-content-tertiary">
                  Add these secrets and workflow to your repository. The pipeline will update the graph automatically on
                  every push to main.
                </p>
                <TeamMcpCiCdStep workspaceId={workspaceId} />
              </DialogBody>
              <DialogFooter className="justify-between">
                <Button variant="ghost" onClick={handleCiCdBack}>
                  Back
                </Button>
                <Button variant="default" onClick={handleFinish}>
                  Finish setup
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
