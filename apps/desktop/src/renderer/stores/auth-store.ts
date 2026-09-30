/**
 * Auth Store - Zustand store for authentication state
 */

import { create } from 'zustand';

interface AuthState {
  isLoggedIn: boolean;
  email: string | null;
  userId: string | null;
  loading: boolean;
  error: string | null;
  /** Increments only on login/callback events (not token refreshes). */
  authChangeCount: number;

  checkAuthStatus: () => Promise<void>;
  login: () => Promise<void>;
  logout: () => Promise<void>;
}

// Deduplication guard for checkAuthStatus
let checkAuthPromise: Promise<void> | null = null;

export const useAuthStore = create<AuthState>((set, _get) => ({
  isLoggedIn: false,
  email: null,
  userId: null,
  loading: false,
  error: null,
  authChangeCount: 0,

  checkAuthStatus: async () => {
    if (checkAuthPromise) return checkAuthPromise;
    checkAuthPromise = (async () => {
      try {
        const status = await window.electronAPI.getWorkspaceAuthStatus();
        set({
          isLoggedIn: status.isLoggedIn,
          email: status.email,
          userId: status.userId,
        });
      } catch {
        // Background auth check — don't surface errors to the UI
      } finally {
        checkAuthPromise = null;
      }
    })();
    return checkAuthPromise;
  },

  login: async () => {
    try {
      set({ loading: true, error: null });
      await window.electronAPI.workspaceLogin();
      // Login is now async via deep link — the onAuthChange listener
      // will update isLoggedIn when the callback completes.
      // Set timeout to clear loading if deep link never arrives.
      setTimeout(() => {
        const state = useAuthStore.getState();
        if (state.loading && !state.isLoggedIn) {
          useAuthStore.setState({ loading: false, error: 'Login timed out. Please try again.' });
        }
      }, 120_000);
    } catch (err) {
      set({ loading: false, error: (err as Error).message });
    }
  },

  logout: async () => {
    try {
      set({ loading: true, error: null });
      await window.electronAPI.workspaceLogout();
      set({ isLoggedIn: false, email: null, userId: null, loading: false });
    } catch (err) {
      set({ loading: false, error: (err as Error).message });
    }
  },
}));

// Re-check auth when window regains focus (debounced to avoid rapid re-checks on alt-tab)
let focusTimer: ReturnType<typeof setTimeout> | null = null;
window.addEventListener('focus', () => {
  if (focusTimer) clearTimeout(focusTimer);
  focusTimer = setTimeout(() => {
    useAuthStore.getState().checkAuthStatus();
  }, 1000);
});

// Listen for auth change events pushed from the main process
if (typeof window.electronAPI?.onAuthChange === 'function') {
  window.electronAPI.onAuthChange((status) => {
    useAuthStore.setState((prev) => ({
      isLoggedIn: status.isLoggedIn,
      email: status.email,
      userId: status.userId,
      loading: false,
      // Only bump on login/callback — not on background token refreshes
      authChangeCount: status.reason === 'callback' ? prev.authChangeCount + 1 : prev.authChangeCount,
    }));
  });
}
