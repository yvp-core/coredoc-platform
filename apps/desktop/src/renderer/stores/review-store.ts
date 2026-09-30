import { create } from 'zustand';
import type { GraphReviewData, ApprovalStatus } from '../../shared/ipc-types';

export type ReviewFilter = 'entrypoints' | 'entities' | 'externalCalls' | 'stateStores' | 'routes';

interface ReviewState {
  repoName: string | null;
  graphData: GraphReviewData | null;
  approvalStatus: ApprovalStatus | null;
  isLoading: boolean;
  filter: ReviewFilter;
  searchQuery: string;

  loadGraphData: (projectId: string, repoName: string) => Promise<void>;
  loadApprovalStatus: (projectId: string, repoName: string) => Promise<void>;
  approveParser: (projectId: string, repoName: string) => Promise<{ success: boolean; error?: string }>;
  setFilter: (filter: ReviewFilter) => void;
  setSearchQuery: (query: string) => void;
  reset: () => void;
}

export const useReviewStore = create<ReviewState>((set, get) => ({
  repoName: null,
  graphData: null,
  approvalStatus: null,
  isLoading: false,
  filter: 'entrypoints',
  searchQuery: '',

  loadGraphData: async (projectId, repoName) => {
    set({ isLoading: true, repoName });
    try {
      const result = await window.electronAPI.getGraphReviewData(projectId, repoName);
      if (result.success && result.data) {
        // Default to first non-empty tab
        const data = result.data;
        let defaultFilter: ReviewFilter = 'entrypoints';
        if (data.entrypoints.length > 0) defaultFilter = 'entrypoints';
        else if (data.entities.length > 0) defaultFilter = 'entities';
        else if (data.externalCalls.length > 0) defaultFilter = 'externalCalls';
        else if (data.stateStores.length > 0) defaultFilter = 'stateStores';
        else if (data.routes.length > 0) defaultFilter = 'routes';

        set({ graphData: data, isLoading: false, filter: defaultFilter });
      } else {
        set({ graphData: null, isLoading: false });
      }
    } catch (error) {
      console.error('Failed to load graph data:', error);
      set({ graphData: null, isLoading: false });
    }
  },

  loadApprovalStatus: async (projectId, repoName) => {
    try {
      const result = await window.electronAPI.getApprovalStatus(projectId, repoName);
      if (result.success && result.status) {
        set({ approvalStatus: result.status });
      }
    } catch (error) {
      console.error('Failed to load approval status:', error);
    }
  },

  approveParser: async (projectId, repoName) => {
    const result = await window.electronAPI.approveParser(projectId, repoName);
    if (result.success) {
      await get().loadApprovalStatus(projectId, repoName);

      try {
        const { useProjectDetailStore } = await import('./project-detail-store');
        await useProjectDetailStore.getState().refreshRepoState(repoName);

        const state = useProjectDetailStore.getState().repoStates.get(repoName);
        const { deriveRepoStatus } = await import('../lib/repo-status');
        const status = deriveRepoStatus(state, undefined);
        const { useProjectsStore } = await import('./projects-store');
        useProjectsStore.getState().syncRepoStatus(projectId, repoName, status);
      } catch {
        // Non-critical
      }
    }
    return result;
  },

  setFilter: (filter) => set({ filter }),
  setSearchQuery: (searchQuery) => set({ searchQuery }),

  reset: () =>
    set({
      repoName: null,
      graphData: null,
      approvalStatus: null,
      isLoading: false,
      filter: 'entrypoints',
      searchQuery: '',
    }),
}));
