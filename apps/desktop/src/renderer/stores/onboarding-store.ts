/**
 * Onboarding Store — tracks which invited workspace (if any) should show
 * the onboarding wizard right now.
 *
 * Flow:
 *  - checkForNewInvites(userId, workspaces) runs on auth change / workspace
 *    list refresh. It diffs workspaces against the local "seen" list and
 *    promotes the newest qualifying workspace to activeWorkspaceId if the
 *    wizard isn't already open.
 *  - The wizard calls markActiveOnboarded(finished) when the user hits
 *    Finish, Skip, or closes the dialog. This marks the workspace seen
 *    and clears activeWorkspaceId. The queue does NOT auto-advance — any
 *    other new invites wait for the next checkForNewInvites call (i.e.,
 *    next app launch or next auth change).
 */

import { create } from 'zustand';
import type { Workspace } from './workspace-store';
import { filterNewInvites } from './onboarding-filter';

interface OnboardingState {
  activeWorkspaceId: string | null;
  activeUserId: string | null;
  checking: boolean;

  checkForNewInvites: (userId: string, workspaces: Workspace[]) => Promise<void>;
  markActiveOnboarded: () => Promise<void>;
}

export const useOnboardingStore = create<OnboardingState>((set, get) => {
  // Guard against overlapping checks (auth callback + workspace reload can race).
  // Scoped to the store closure so test resets / hot reloads don't keep a stale ref.
  let checkPromise: Promise<void> | null = null;

  return {
    activeWorkspaceId: null,
    activeUserId: null,
    checking: false,

    checkForNewInvites: async (userId, workspaces) => {
      if (checkPromise) return checkPromise;
      checkPromise = (async () => {
        try {
          set({ checking: true });
          if (get().activeWorkspaceId) return; // wizard already open, don't re-queue
          const seenList = await window.electronAPI.onboardingListSeen(userId);
          const seen = new Set(seenList);
          const candidates = filterNewInvites(workspaces, seen);
          if (candidates.length > 0) {
            set({ activeWorkspaceId: candidates[0].id, activeUserId: userId });
          }
        } catch {
          // Silently ignore — onboarding is a best-effort nicety
        } finally {
          set({ checking: false });
          checkPromise = null;
        }
      })();
      return checkPromise;
    },

    markActiveOnboarded: async () => {
      const { activeWorkspaceId, activeUserId } = get();
      if (!activeWorkspaceId || !activeUserId) return;
      // Use the userId the wizard was opened for, not the current auth user —
      // mid-wizard auth changes shouldn't write the seen-mark under the wrong key.
      await window.electronAPI.onboardingMarkSeen(activeUserId, activeWorkspaceId);
      set({ activeWorkspaceId: null, activeUserId: null });
    },
  };
});
