import { create } from 'zustand';
import type { DocFileInfo, DocsPromptOption } from '../../shared/ipc-types';

type DocsView = 'catalog' | 'list' | 'viewer';

interface DocsState {
  view: DocsView;
  docs: DocFileInfo[];
  isLoading: boolean;
  searchQuery: string;
  selectedDoc: DocFileInfo | null;
  selectedDocContent: string | null;
  isLoadingContent: boolean;
  promptOptions: DocsPromptOption[];
  isLoadingPromptOptions: boolean;
  activeDagPath?: string;
  _projectId: string;
  _repoNames: string[];
  _workspaceId?: string;

  /** Load docs for repos. If repos changed, resets state first. If same, refreshes list. */
  initForRepos: (projectId: string, repoNames: string[], workspaceId?: string) => Promise<void>;
  loadDocs: (projectId: string, repoNames: string[]) => Promise<void>;
  setWorkspaceId: (workspaceId?: string) => void;
  loadPromptOptions: (dagPath?: string) => Promise<void>;
  setActiveDagPath: (dagPath?: string) => Promise<void>;
  setSearchQuery: (query: string) => void;
  selectDoc: (doc: DocFileInfo) => Promise<void>;
  goBackToList: () => void;
  deleteDoc: (repoName: string, relativePath: string) => Promise<void>;
  reset: () => void;
}

export const useDocsStore = create<DocsState>((set, get) => ({
  view: 'catalog',
  docs: [],
  isLoading: false,
  searchQuery: '',
  selectedDoc: null,
  selectedDocContent: null,
  isLoadingContent: false,
  promptOptions: [],
  isLoadingPromptOptions: false,
  activeDagPath: undefined,
  _projectId: '',
  _repoNames: [],
  _workspaceId: undefined,

  setWorkspaceId: (workspaceId) => {
    set({ _workspaceId: workspaceId });
  },

  initForRepos: async (projectId, repoNames, workspaceId) => {
    if (projectId !== get()._projectId) {
      set({ _projectId: projectId });
    }
    if (workspaceId !== get()._workspaceId) {
      set({ _workspaceId: workspaceId });
    }
    const currentKey = get()._repoNames.join(',');
    const newKey = repoNames.join(',');
    const { activeDagPath } = get();

    if (currentKey === newKey && get().docs.length > 0) {
      // Same repos, already loaded — silently refresh the file list
      // but don't reset view/search/selection
      try {
        const result = await window.electronAPI.listDocs(projectId, repoNames, activeDagPath, get()._workspaceId);
        if (result.success && result.docs) {
          set({ docs: result.docs });
        }
      } catch {
        // ignore refresh errors
      }
      return;
    }

    if (currentKey !== newKey) {
      // Different repos — full reset + load
      set({
        view: 'catalog',
        docs: [],
        isLoading: false,
        searchQuery: '',
        selectedDoc: null,
        selectedDocContent: null,
        isLoadingContent: false,
        promptOptions: [],
        isLoadingPromptOptions: false,
        _repoNames: [],
      });
    }

    await get().loadPromptOptions(activeDagPath);

    if (repoNames.length > 0) {
      await get().loadDocs(projectId, repoNames);
    }
  },

  loadDocs: async (projectId, repoNames) => {
    const { activeDagPath, _workspaceId } = get();
    set({ isLoading: true, _repoNames: repoNames, _projectId: projectId });
    try {
      const result = await window.electronAPI.listDocs(projectId, repoNames, activeDagPath, _workspaceId);
      if (result.success && result.docs) {
        set({
          docs: result.docs,
          view: result.docs.length > 0 ? 'list' : 'catalog',
          isLoading: false,
        });
      } else {
        set({ docs: [], view: 'catalog', isLoading: false });
      }
    } catch (error) {
      console.error('Failed to load docs:', error);
      set({ docs: [], view: 'catalog', isLoading: false });
    }
  },

  loadPromptOptions: async (dagPath) => {
    set({ isLoadingPromptOptions: true });
    try {
      const result = await window.electronAPI.listDocsPrompts(dagPath);
      if (result.success && result.prompts) {
        set({
          promptOptions: result.prompts,
          isLoadingPromptOptions: false,
        });
      } else {
        set({
          promptOptions: [],
          isLoadingPromptOptions: false,
        });
      }
    } catch (error) {
      console.error('Failed to load prompt options:', error);
      set({
        promptOptions: [],
        isLoadingPromptOptions: false,
      });
    }
  },

  setActiveDagPath: async (dagPath) => {
    const normalizedDagPath = dagPath?.trim() ? dagPath : undefined;
    set({ activeDagPath: normalizedDagPath });

    await get().loadPromptOptions(normalizedDagPath);

    const { _projectId, _repoNames } = get();
    if (_repoNames.length > 0) {
      await get().loadDocs(_projectId, _repoNames);
    }
  },

  setSearchQuery: (query) => {
    set({ searchQuery: query });
  },

  selectDoc: async (doc) => {
    set({ selectedDoc: doc, isLoadingContent: true, view: 'viewer' });
    try {
      const result = await window.electronAPI.readDoc(
        get()._projectId,
        doc.repoName,
        doc.relativePath,
        get()._workspaceId,
      );
      if (result.success && result.content) {
        set({ selectedDocContent: result.content, isLoadingContent: false });
      } else {
        set({ selectedDocContent: null, isLoadingContent: false });
      }
    } catch (error) {
      console.error('Failed to read doc:', error);
      set({ selectedDocContent: null, isLoadingContent: false });
    }
  },

  goBackToList: () => {
    set({ view: 'list', selectedDoc: null, selectedDocContent: null });
  },

  deleteDoc: async (repoName, relativePath) => {
    try {
      console.log(`[DocsStore] Asking IPC to delete ${repoName}/${relativePath}`);
      const result = await window.electronAPI.deleteDoc(get()._projectId, repoName, relativePath, get()._workspaceId);
      console.log(`[DocsStore] IPC delete result:`, result);
      if (result.success) {
        set((state) => {
          const remainingDocs = state.docs.filter((d) => d.repoName !== repoName || d.relativePath !== relativePath);
          return {
            docs: remainingDocs,
            view: remainingDocs.length === 0 ? 'catalog' : state.view,
          };
        });
      } else {
        console.error('Failed to delete doc:', result.error);
      }
    } catch (error) {
      console.error('Failed to delete doc:', error);
    }
  },

  reset: () => {
    set({
      view: 'catalog',
      docs: [],
      isLoading: false,
      searchQuery: '',
      selectedDoc: null,
      selectedDocContent: null,
      isLoadingContent: false,
      promptOptions: [],
      isLoadingPromptOptions: false,
      activeDagPath: undefined,
      _projectId: '',
      _repoNames: [],
    });
  },
}));

export function useFilteredDocs() {
  const docs = useDocsStore((s) => s.docs);
  const query = useDocsStore((s) => s.searchQuery);

  if (!query.trim()) return docs;

  const lower = query.toLowerCase();
  return docs.filter((d) => d.title.toLowerCase().includes(lower) || d.repoName.toLowerCase().includes(lower));
}
