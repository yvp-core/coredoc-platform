import React, { useEffect, useState } from 'react';
import { Outlet } from 'react-router-dom';
import { AddProjectDialog } from './AddProjectDialog';
import { Sidebar } from './Sidebar';
import { InvitedUserOnboardingWizard } from './InvitedUserOnboardingWizard';
import { ServerCompatBanner } from './ServerCompatBanner';
import { usePageView } from '../telemetry';
import { useAuthStore } from '../stores/auth-store';
import { useWorkspaceStore } from '../stores/workspace-store';
import { useOnboardingStore } from '../stores/onboarding-store';

/* ------------------------------------------------------------------ */
/*  Root layout                                                        */
/* ------------------------------------------------------------------ */

export function AppLayout() {
  usePageView();
  const [addDialogOpen, setAddDialogOpen] = useState(false);

  const { isLoggedIn, userId, authChangeCount } = useAuthStore();
  const { workspaces, loadWorkspaces } = useWorkspaceStore();
  const { checkForNewInvites } = useOnboardingStore();

  useEffect(() => {
    const handler = () => setAddDialogOpen(true);
    window.addEventListener('open-add-workspace', handler);
    return () => window.removeEventListener('open-add-workspace', handler);
  }, []);

  // When the user logs in / the login callback fires, make sure the workspace
  // list is fresh, then check for new invites.
  // biome-ignore lint/correctness/useExhaustiveDependencies: explicit re-trigger on auth callback
  useEffect(() => {
    if (!isLoggedIn || !userId) return;
    void (async () => {
      await loadWorkspaces();
    })();
  }, [isLoggedIn, userId, authChangeCount, loadWorkspaces]);

  // Diff workspaces against the seen set whenever the list changes and we
  // have a userId. onboarding-store short-circuits if a wizard is already open.
  useEffect(() => {
    if (!isLoggedIn || !userId) return;
    if (workspaces.length === 0) return;
    void checkForNewInvites(userId, workspaces);
  }, [isLoggedIn, userId, workspaces, checkForNewInvites]);

  return (
    <div className="flex flex-col h-screen overflow-hidden">
      {window.electronAPI?.platform === 'darwin' && (
        <div className="drag-region relative z-[60] h-10 shrink-0 rounded-t-xl border-b border-border-input bg-[linear-gradient(180deg,rgba(255,255,255,0.7)_0%,rgba(255,255,255,0.65)_100%)]" />
      )}
      <ServerCompatBanner />
      <div className="flex flex-1 min-h-0 p-2 pl-0">
        <Sidebar />
        {/* The content underlay is `Background/Secondary` (0.64→0.56), not Surface B's
            lighter 0.57→0.48 — the legacy `.gradient-1` was the wrong recipe and read as
            too transparent over the page ground. `.blur-1` goes with it: a 1px
            backdrop-filter is invisible and still costs a repaint (perf rule 1). */}
        <main className="flex-1 flex flex-col overflow-hidden rounded-2xl border border-border-primary shadow-foundation bg-secondary-gradient backdrop-blur-[3px]">
          <Outlet />
        </main>
      </div>
      <AddProjectDialog open={addDialogOpen} onOpenChange={setAddDialogOpen} />
      <InvitedUserOnboardingWizard />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Page header                                                        */
/* ------------------------------------------------------------------ */

export function PageHeader({ children }: { children: React.ReactNode }) {
  return (
    <div className="pt-4 pb-2 px-6 shrink-0 relative">
      <div className="flex items-center justify-between">{children}</div>
    </div>
  );
}
