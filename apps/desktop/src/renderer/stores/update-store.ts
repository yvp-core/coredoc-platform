import { create } from 'zustand';

type UpdateStatus = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error';

interface UpdateState {
  status: UpdateStatus;
  currentVersion?: string;
  availableVersion?: string;
  downloadProgress?: number;
  error?: string;

  checkForUpdate: () => Promise<void>;
  installUpdate: () => Promise<void>;
  initListener: () => () => void;
}

export const useUpdateStore = create<UpdateState>((set) => ({
  status: 'idle',
  currentVersion: undefined,
  availableVersion: undefined,
  downloadProgress: undefined,
  error: undefined,

  checkForUpdate: async () => {
    set({ status: 'checking' });
    await window.electronAPI.checkForUpdate();
  },

  installUpdate: async () => {
    await window.electronAPI.installUpdate();
  },

  initListener: () => {
    // Load app version
    window.electronAPI.getAppVersion().then((version) => {
      set({ currentVersion: version });
    });

    // Load initial status
    window.electronAPI.getUpdateStatus().then((info) => {
      set({
        status: info.status,
        availableVersion: info.version,
        downloadProgress: info.downloadProgress,
        error: info.error,
      });
    });

    // Listen for status changes
    const unsubscribe = window.electronAPI.onUpdateStatus((info) => {
      set({
        status: info.status,
        availableVersion: info.version,
        downloadProgress: info.downloadProgress,
        error: info.error,
      });
    });

    return unsubscribe;
  },
}));
