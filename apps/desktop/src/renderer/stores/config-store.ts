import { create } from 'zustand';
import type { CoredocConfigSerialized, ConfigValidateResult } from '../../shared/ipc-types';

interface ConfigState {
  config: CoredocConfigSerialized | null;
  isLoading: boolean;
  error: string | null;
  validationResult: ConfigValidateResult | null;

  loadConfig: (configPath?: string) => Promise<void>;
  saveConfig: () => Promise<boolean>;
  validateConfig: () => Promise<ConfigValidateResult>;
}

export const useConfigStore = create<ConfigState>((set, get) => ({
  config: null,
  isLoading: false,
  error: null,
  validationResult: null,

  loadConfig: async (configPath?: string) => {
    set({ isLoading: true, error: null });

    try {
      const result = await window.electronAPI.loadConfig(configPath);

      if (result.success && result.config) {
        set({ config: result.config, isLoading: false });
      } else {
        set({ error: result.error || 'Failed to load config', isLoading: false });
      }
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Unknown error',
        isLoading: false,
      });
    }
  },

  saveConfig: async () => {
    const { config } = get();
    if (!config) return false;

    set({ isLoading: true, error: null });

    try {
      const result = await window.electronAPI.saveConfig(config);
      if (result.success) {
        set({ isLoading: false });
        return true;
      } else {
        set({ error: result.error || 'Failed to save config', isLoading: false });
        return false;
      }
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Unknown error',
        isLoading: false,
      });
      return false;
    }
  },

  validateConfig: async () => {
    try {
      const result = await window.electronAPI.validateConfig();
      set({ validationResult: result });
      return result;
    } catch (error) {
      const errorResult: ConfigValidateResult = {
        valid: false,
        errors: [{ path: '', message: error instanceof Error ? error.message : 'Unknown error' }],
        warnings: [],
      };
      set({ validationResult: errorResult });
      return errorResult;
    }
  },
}));
