import * as React from 'react';
import { useNavigate } from 'react-router-dom';
import { Dialog, DialogContent, DialogBody, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { Button } from './ui/button';
import { useOnboardingStore } from '../stores/onboarding-store';
import { useWorkspaceStore } from '../stores/workspace-store';
import { useProjectsStore } from '../stores/projects-store';
import { trackEvent } from '../telemetry';
import { WelcomeStep, welcomeTitle } from './invited-onboarding/WelcomeStep';
import { McpStep } from './invited-onboarding/McpStep';
import { LinkRepositoriesStep } from './invited-onboarding/LinkRepositoriesStep';
import { Field } from './ui/field';
import { Label } from './ui/label';
import { Checkbox } from './ui/checkbox';
import type { LinkedRepo } from '../../shared/ipc-types';

type StepId = 'welcome' | 'mcp' | 'link';

function stepTitle(id: StepId, workspaceName: string): string {
  switch (id) {
    case 'welcome':
      return welcomeTitle(workspaceName);
    case 'mcp':
      return 'Connect MCP';
    case 'link':
      return 'Link repositories';
  }
}

export function InvitedUserOnboardingWizard() {
  const navigate = useNavigate();
  const { activeWorkspaceId, markActiveOnboarded } = useOnboardingStore();
  const { workspaces, repos, selectWorkspace } = useWorkspaceStore();
  const { projects } = useProjectsStore();

  const [steps, setSteps] = React.useState<StepId[]>([]);
  const [stepIdx, setStepIdx] = React.useState(0);
  const [linked, setLinked] = React.useState<LinkedRepo[]>([]);
  const [skipChecked, setSkipChecked] = React.useState(false);

  const workspace = React.useMemo(
    () => workspaces.find((w) => w.id === activeWorkspaceId),
    [workspaces, activeWorkspaceId],
  );

  // On open: load step list + select workspace so repos are available.
  React.useEffect(() => {
    if (!activeWorkspaceId) return;
    let cancelled = false;
    trackEvent('onboarding_started', { workspaceId: activeWorkspaceId });
    (async () => {
      setSteps([]);
      setStepIdx(0);
      setLinked([]);
      setSkipChecked(false);
      await selectWorkspace(activeWorkspaceId);
      if (cancelled) return;
      setSteps(['welcome', 'mcp', 'link']);
    })();
    return () => {
      cancelled = true;
    };
  }, [activeWorkspaceId, selectWorkspace]);

  // Refresh linked repos when entering the link step (or when active workspace changes mid-flow).
  React.useEffect(() => {
    if (!activeWorkspaceId || steps[stepIdx] !== 'link') return;
    let cancelled = false;
    void window.electronAPI.getLinkedRepos(activeWorkspaceId).then((next) => {
      if (!cancelled) setLinked(next);
    });
    return () => {
      cancelled = true;
    };
  }, [activeWorkspaceId, stepIdx, steps]);

  if (!activeWorkspaceId || !workspace || steps.length === 0) return null;

  const currentStep = steps[stepIdx];
  const isLast = stepIdx === steps.length - 1;
  const isFirst = stepIdx === 0;

  const markAndNavigate = async () => {
    const id = activeWorkspaceId;
    await markActiveOnboarded();
    const project = projects.find((p) => p.cloudMember?.workspaceId === id || p.cloud?.workspaceId === id);
    const projectIdForRoute = project?.id ?? `cloud:${id}`;
    navigate(`/project/${encodeURIComponent(projectIdForRoute)}`);
  };

  const refreshLinked = async () => {
    if (!activeWorkspaceId) return;
    const next = await window.electronAPI.getLinkedRepos(activeWorkspaceId);
    setLinked(next);
  };

  const handleLink = async (repoName: string) => {
    if (!activeWorkspaceId) return;
    const result = await window.electronAPI.linkRepo(activeWorkspaceId, repoName);
    if (result.success && !result.canceled) {
      await refreshLinked();
    }
  };

  const handleUnlink = async (repoName: string) => {
    if (!activeWorkspaceId) return;
    await window.electronAPI.removeLinkedRepo(activeWorkspaceId, repoName);
    await refreshLinked();
  };

  const allLinked = repos.length > 0 && repos.every((r) => linked.some((l) => l.repoName === r.repoName));

  const goNext = async () => {
    trackEvent('onboarding_step_completed', { workspaceId: activeWorkspaceId, stepName: currentStep });
    if (isLast) {
      // Skipped path: user reached the link step without linking and ticked the skip box.
      if (currentStep === 'link' && !allLinked && skipChecked) {
        trackEvent('onboarding_skipped', { workspaceId: activeWorkspaceId, stepName: 'link' });
      } else {
        trackEvent('onboarding_finished', { workspaceId: activeWorkspaceId });
      }
      await markAndNavigate();
    } else {
      setStepIdx(stepIdx + 1);
    }
  };

  const handleClose = async () => {
    trackEvent('onboarding_skipped', { workspaceId: activeWorkspaceId, stepName: currentStep });
    await markActiveOnboarded();
  };

  const canGoNext = (() => {
    if (currentStep === 'link') return allLinked || skipChecked;
    return true;
  })();

  return (
    <Dialog
      open={true}
      onOpenChange={(isOpen) => {
        if (!isOpen) void handleClose();
      }}
    >
      <DialogContent className="sm:max-w-[640px]" showCloseButton={false}>
        <DialogHeader className="flex-row items-center justify-between gap-3">
          <DialogTitle className="flex-1 min-w-0 truncate">{stepTitle(currentStep, workspace.name)}</DialogTitle>
          <div className="flex items-center gap-1.5 shrink-0 mr-7">
            {stepIdx > 0 && (
              <span className="text-xs font-normal text-content-quaternary">
                Step {stepIdx}/{steps.length - 1}
              </span>
            )}
          </div>
        </DialogHeader>

        <DialogBody className="overflow-y-auto max-h-[60vh]">
          {currentStep === 'welcome' && <WelcomeStep workspaceName={workspace.name} role={workspace.role} />}
          {currentStep === 'mcp' && <McpStep workspaceId={activeWorkspaceId} />}
          {currentStep === 'link' && activeWorkspaceId && (
            <LinkRepositoriesStep repos={repos} linked={linked} onLink={handleLink} onUnlink={handleUnlink} />
          )}
        </DialogBody>

        <DialogFooter className="justify-between!">
          <div className="flex items-center">
            {currentStep === 'link' && (
              <Field orientation="horizontal">
                <Checkbox
                  id="skip-checkbox"
                  name="skip-checkbox"
                  checked={skipChecked}
                  onCheckedChange={(v) => setSkipChecked(v === true)}
                />
                <Label htmlFor="skip-checkbox">Skip — AI answers will use graph only, without code context</Label>
              </Field>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button type="button" variant="default" onClick={goNext} disabled={!canGoNext}>
              {isFirst ? 'Get started' : isLast ? 'Finish' : 'Next'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
