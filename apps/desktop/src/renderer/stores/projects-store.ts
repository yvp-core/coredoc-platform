import { create } from 'zustand';
import type {
  Project,
  ProjectRepository,
  CreateProjectInput,
  UpdateProjectInput,
  AddRepositoryInput,
  RepositoryStatus,
} from '../types/project';
import type { RepoConfigSerialized, CoredocConfigSerialized, RepoStatusState } from '../../shared/ipc-types';
import { deriveRepoStatus } from '../lib/repo-status';
import { assignProjectId } from '@coredoc/core/utils/project-id';

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Derive projects directly from config.projects array.
 * @param config - The full coredoc config
 * @param stateMap - Optional map of (projectId, repoName) to lightweight repo state
 */
function deriveProjectsFromConfig(config: CoredocConfigSerialized, stateMap?: Map<string, RepoStatusState>): Project[] {
  return config.projects.map((projectConfig) => ({
    id: projectConfig.id,
    name: projectConfig.name,
    createdAt: new Date().toISOString(),
    repositories: projectConfig.repos.map((repo) => ({
      id: repo.name,
      name: repo.name,
      path: repo.path,
      status: deriveRepoStatus(stateMap?.get(getRepoStateKey(projectConfig.id, repo.name)), undefined),
      httpPrefix: repo.httpPrefix,
    })),
    cloud: projectConfig.cloud
      ? {
          enabled: projectConfig.cloud.enabled,
          workspaceId: projectConfig.cloud.workspaceId,
          lastSyncedAt: projectConfig.cloud.lastSyncedAt,
        }
      : undefined,
    wizardCompleted: projectConfig.wizardCompleted,
  }));
}

function getRepoStateKey(projectId: string, repoName: string): string {
  return `${projectId}:${repoName}`;
}

// =============================================================================
// Store Interface
// =============================================================================

interface ProjectsState {
  projects: Project[];
  isLoading: boolean;
  isLoadingLocal: boolean;
  isLoadingCloud: boolean;
  initialized: boolean;
  cloudInitialized: boolean;

  // Project CRUD Actions
  loadProjects: () => Promise<void>;
  loadLocalProjects: () => Promise<void>;
  loadCloudProjects: () => Promise<void>;
  addProject: (input: CreateProjectInput) => Promise<Project>;
  updateProject: (id: string, input: UpdateProjectInput) => Promise<Project | null>;
  deleteProject: (id: string) => Promise<boolean>;
  getProject: (id: string) => Project | undefined;

  // Repository Management Actions
  addRepository: (projectId: string, input: AddRepositoryInput) => Promise<ProjectRepository | null>;
  removeRepository: (projectId: string, repositoryId: string) => Promise<boolean>;

  // Cloud
  setProjectCloud: (
    projectId: string,
    cloud: { enabled: boolean; workspaceId?: string; lastSyncedAt?: string },
  ) => Promise<void>;

  // Cross-store sync
  syncRepoStatus: (projectId: string, repoName: string, status: RepositoryStatus) => void;
  /**
   * Replace many repo statuses in a single store update — used after a project
   * loads its detail state so the cache (used by Sidebar's busy spinner for
   * non-active projects) doesn't drift. Single update = single re-render.
   */
  syncRepoStatusesBatch: (projectId: string, statuses: Map<string, RepositoryStatus>) => void;

  /** Keep list/sidebar badges in sync when wizard completion is persisted outside normal project load. */
  syncWizardCompleted: (projectId: string, wizardCompleted: boolean) => void;
}

// =============================================================================
// Store Implementation
// =============================================================================

// Deduplication guards for concurrent calls (handles StrictMode + rapid re-triggers)
let loadLocalPromise: Promise<void> | null = null;
let loadCloudPromise: Promise<void> | null = null;

export const useProjectsStore = create<ProjectsState>((set, get) => {
  return {
    projects: [],
    isLoading: false,
    isLoadingLocal: false,
    isLoadingCloud: false,
    initialized: false,
    cloudInitialized: false,

    loadProjects: async () => {
      await get().loadLocalProjects();
      get().loadCloudProjects();
    },

    loadLocalProjects: async () => {
      if (loadLocalPromise) return loadLocalPromise;

      set({ isLoadingLocal: true, isLoading: true });

      loadLocalPromise = (async () => {
        try {
          const result = await window.electronAPI.loadConfig();

          if (result.success && result.config) {
            // Names and paths are already known. Status checks must not gate the
            // workspace list, including when a repo's git command is slow.
            const previous = get().projects;
            const localProjects = deriveProjectsFromConfig(result.config).map((project) => ({
              ...project,
              repositories: project.repositories.map(
                (repo): ProjectRepository => ({
                  ...repo,
                  status:
                    previous.find((p) => p.id === project.id)?.repositories.find((r) => r.name === repo.name)?.status ??
                    'checking',
                }),
              ),
            }));
            set({
              projects: [...localProjects, ...previous.filter((p) => p.cloudMember)],
              isLoadingLocal: false,
              isLoading: false,
              initialized: true,
            });
            const repoRefs = result.config.projects.flatMap((project) =>
              project.repos.map((repo) => ({
                projectId: project.id,
                repoName: repo.name,
              })),
            );
            const stateMap = new Map<string, RepoStatusState>();
            await Promise.all(
              repoRefs.map(async ({ projectId, repoName }) => {
                try {
                  const state = await window.electronAPI.getRepoStatusState(projectId, repoName);
                  if (state) {
                    stateMap.set(getRepoStateKey(projectId, repoName), state);
                  }
                } catch (err) {
                  console.warn(`Failed to get state for repo ${repoName}:`, err);
                }
              }),
            );

            // Merge into current state: cloud loading or local edits may have
            // completed while statuses were in flight.
            for (const project of result.config.projects) {
              const statuses = new Map<string, RepositoryStatus>();
              for (const repo of project.repos) {
                const state = stateMap.get(getRepoStateKey(project.id, repo.name));
                const initialStatus = localProjects
                  .find((p) => p.id === project.id)
                  ?.repositories.find((r) => r.name === repo.name)?.status;
                const currentStatus = get()
                  .projects.find((p) => p.id === project.id)
                  ?.repositories.find((r) => r.name === repo.name)?.status;
                // A run or a detail refresh may have supplied newer state while
                // the user was already interacting with the visible workspace.
                if (currentStatus === initialStatus) {
                  if (state) statuses.set(repo.name, deriveRepoStatus(state, undefined));
                  // A completed check must stop spinning even when IPC failed. Preserve an
                  // existing status; the next load/detail refresh can retry missing state.
                  else if (currentStatus === 'checking') statuses.set(repo.name, 'status_unavailable');
                }
              }
              get().syncRepoStatusesBatch(project.id, statuses);
            }
          } else {
            console.error('Failed to load config:', result.error);
            set({ isLoadingLocal: false, isLoading: false, initialized: true });
          }
        } catch (error) {
          console.error('Failed to load local projects:', error);
          set({ isLoadingLocal: false, isLoading: false, initialized: true });
        } finally {
          loadLocalPromise = null;
        }
      })();

      return loadLocalPromise;
    },

    loadCloudProjects: async () => {
      if (loadCloudPromise) return loadCloudPromise;

      set({ isLoadingCloud: true });

      loadCloudPromise = (async () => {
        try {
          const authStatus = await window.electronAPI.getWorkspaceAuthStatus();
          console.log('[ProjectsStore] Auth status:', authStatus);

          // Get current local projects (strip any previous cloud-only projects)
          const localProjects = get().projects.filter((p) => !p.cloudMember);

          if (!authStatus.isLoggedIn) {
            // Not logged in — clear any cloud projects and finish
            set({ projects: localProjects, isLoadingCloud: false, cloudInitialized: true });
            return;
          }

          const workspaces = await window.electronAPI.workspaceListWorkspaces();
          console.log(
            '[ProjectsStore] All workspaces from server:',
            workspaces.map((ws) => ({ id: ws.id, name: ws.name, role: ws.role, slug: ws.slug })),
          );

          const localWorkspaceIds = new Set(
            localProjects.filter((p) => p.cloud?.workspaceId).map((p) => p.cloud!.workspaceId),
          );
          console.log('[ProjectsStore] Local workspace IDs (already represented):', [...localWorkspaceIds]);

          const cloudProjects: Project[] = [];
          for (const ws of workspaces) {
            // A workspace is surfaced as its own cloud project unless a local
            // project already represents it (config.projects[].cloud.workspaceId).
            // Role is irrelevant: an owned workspace can be driven from another
            // machine/config (e.g. a dev COREDOC_HOME) and still has no local
            // twin here.
            const dominated = localWorkspaceIds.has(ws.id);
            console.log(
              `[ProjectsStore] Workspace "${ws.name}" (${ws.id}): role=${ws.role}, locallyRepresented=${dominated}, willAdd=${!dominated}`,
            );
            if (!dominated) {
              try {
                const repos = await window.electronAPI.workspaceListRepos(ws.id);
                console.log(
                  `[ProjectsStore] Workspace "${ws.name}" repos:`,
                  repos.map((r) => r.repoName),
                );
                cloudProjects.push({
                  id: `cloud:${ws.id}`,
                  name: ws.name,
                  createdAt: ws.createdAt,
                  repositories: repos.map((r) => ({
                    id: r.repoName,
                    name: r.repoName,
                    path: '',
                    status: 'graph_up_to_date' as RepositoryStatus,
                  })),
                  cloudMember: { workspaceId: ws.id },
                });
              } catch (err) {
                console.warn(`[ProjectsStore] Failed to load repos for cloud workspace ${ws.id}:`, err);
              }
            }
          }

          const allProjects = [...get().projects.filter((p) => !p.cloudMember), ...cloudProjects];
          console.log(
            `[ProjectsStore] Final result: ${allProjects.length} total projects, ${cloudProjects.length} cloud member projects`,
          );
          set({ projects: allProjects, isLoadingCloud: false, cloudInitialized: true });
        } catch (err) {
          console.warn('[ProjectsStore] Cloud workspace loading failed:', err);
          set({ isLoadingCloud: false, cloudInitialized: true });
        } finally {
          loadCloudPromise = null;
        }
      })();

      return loadCloudPromise;
    },

    addProject: async (input) => {
      set({ isLoading: true });

      try {
        // Load current config
        const loadResult = await window.electronAPI.loadConfig();
        if (!loadResult.success || !loadResult.config) {
          throw new Error('Failed to load config');
        }

        const config = loadResult.config;
        const projectName = input.name.trim();

        // Check if project already exists
        const existingProject = config.projects.find((p) => p.name === projectName);
        if (existingProject) {
          throw new Error(`Project "${projectName}" already exists`);
        }

        // Build repos list for the new project
        const projectRepos: RepoConfigSerialized[] = [];

        // If new folders are provided, add them as new repos (after checking for name collisions)
        if (input.newFolders && input.newFolders.length > 0) {
          const existingNames = new Set(projectRepos.map((r) => r.name));
          for (const folder of input.newFolders) {
            if (existingNames.has(folder.name)) {
              throw new Error(
                `A repo named "${folder.name}" already exists. Rename it or remove the existing one first.`,
              );
            }
            projectRepos.push({
              name: folder.name,
              path: folder.path,
              type: folder.type,
            });
            existingNames.add(folder.name);
          }
        }

        // Compute a unique stable id for the new project
        const takenIds = new Set([...config.projects.map((p) => p.id ?? ''), ...(loadResult.reservedProjectIds ?? [])]);
        const newProjectId = assignProjectId(projectName, takenIds);

        // Add new project to config
        config.projects.push({
          id: newProjectId,
          name: projectName,
          repos: projectRepos,
        });

        // Save updated config
        const saveResult = await window.electronAPI.saveConfig(config);
        if (!saveResult.success) {
          throw new Error(saveResult.error || 'Failed to save config');
        }

        // Build local state from the already-assembled projectRepos (which have paths)
        const newProject: Project = {
          id: newProjectId,
          name: projectName,
          createdAt: new Date().toISOString(),
          repositories: projectRepos.map((repo) => ({
            id: repo.name,
            name: repo.name,
            path: repo.path ?? '',
            status: 'not_started' as RepositoryStatus,
            httpPrefix: repo.httpPrefix,
          })),
        };

        // Update local state
        const { projects } = get();
        set({
          projects: [...projects, newProject],
          isLoading: false,
        });

        return newProject;
      } catch (error) {
        console.error('Failed to create project:', error);
        set({ isLoading: false });
        throw error;
      }
    },

    updateProject: async (id, input) => {
      set({ isLoading: true });

      try {
        // Load current config
        const loadResult = await window.electronAPI.loadConfig();
        if (!loadResult.success || !loadResult.config) {
          throw new Error('Failed to load config');
        }

        const config = loadResult.config;
        const newName = input.name?.trim();

        // Find by id (with fallback to name for legacy configs without id)
        const projectEntry = config.projects.find((p) => p.id === id);

        // If renaming, update the project in config.projects
        if (newName && newName !== projectEntry?.name) {
          // Check if new name already exists
          const existingProject = config.projects.find((p) => p.name === newName);
          if (existingProject) {
            throw new Error(`Project "${newName}" already exists`);
          }

          if (projectEntry) {
            projectEntry.name = newName;
          }
        }

        // Save updated config
        const saveResult = await window.electronAPI.saveConfig(config);
        if (!saveResult.success) {
          throw new Error(saveResult.error || 'Failed to save config');
        }

        // Sync name to cloud if project has cloud enabled
        const projectConfig = config.projects.find((p) => p.id === id);
        if (newName && projectConfig?.cloud?.enabled && projectConfig.cloud.workspaceId) {
          try {
            await window.electronAPI.workspaceUpdateName(projectConfig.cloud.workspaceId, newName);
          } catch {
            // Non-critical: cloud name sync failure shouldn't block local rename
          }
        }

        // Update local state
        const { projects } = get();
        const projectIndex = projects.findIndex((p) => p.id === id);

        if (projectIndex === -1) {
          set({ isLoading: false });
          return null;
        }

        const updatedProject: Project = {
          ...projects[projectIndex],
          // id (stable slug) does not change on rename — only display name changes
          name: newName || projects[projectIndex].name,
          ...(input.lastSyncAt !== undefined && { lastSyncAt: input.lastSyncAt }),
        };

        const updatedProjects = [...projects];
        updatedProjects[projectIndex] = updatedProject;

        set({ projects: updatedProjects, isLoading: false });

        return updatedProject;
      } catch (error) {
        console.error('Failed to update project:', error);
        set({ isLoading: false });
        throw error;
      }
    },

    deleteProject: async (id) => {
      set({ isLoading: true });

      try {
        // Load current config
        const loadResult = await window.electronAPI.loadConfig();
        if (!loadResult.success || !loadResult.config) {
          throw new Error('Failed to load config');
        }

        const config = loadResult.config;

        // Find the project and clean up its artifacts before removing it.
        const projectIndex = config.projects.findIndex((p) => p.id === id);
        if (projectIndex !== -1) {
          const removedProject = config.projects[projectIndex];

          // Step 1: hard-delete each repo's parser/output/docs via the main process.
          // The IPC handler at config-manager.ts:removeRepository handles all the
          // on-disk cleanup AND removes the repo from the project's repos array,
          // so we don't splice it ourselves.
          for (const repo of [...removedProject.repos]) {
            try {
              await window.electronAPI.removeRepository(id, repo.name);
            } catch (err) {
              console.warn(`Failed to clean repo ${repo.name} during project delete:`, err);
            }
          }

          // Step 2: remove the project entry itself (re-find since removeRepository
          // mutates project.repos via the on-disk write).
          const reloadResult = await window.electronAPI.loadConfig();
          const reloadedConfig = reloadResult.success && reloadResult.config ? reloadResult.config : config;
          const finalIndex = reloadedConfig.projects.findIndex((p) => p.id === id);
          if (finalIndex !== -1) {
            reloadedConfig.projects.splice(finalIndex, 1);
            const saveResult = await window.electronAPI.saveConfig(reloadedConfig);
            if (!saveResult.success) {
              throw new Error(saveResult.error || 'Failed to save config after project delete');
            }
          }

          // Step 3: delete the project's chat-session directory (sessions are
          // stored at sessionsDir/{projectId}/{sessionId}.json — see session-manager.ts:59).
          try {
            await window.electronAPI.deleteProjectSessions(id);
          } catch (err) {
            console.warn(`Failed to delete sessions for project ${id}:`, err);
          }

          // Keep the project database as recoverable cache data. An external
          // MCP process may still have SQLite/WAL handles open, so unlinking it
          // here can corrupt the file. Config-derived scopes make it invisible.
          // Config loading reserves ids with retained files, so a later project
          // cannot inherit it.
        }

        // Update local state
        const { projects } = get();
        const updatedProjects = projects.filter((p) => p.id !== id);
        set({
          projects: updatedProjects,
          isLoading: false,
        });

        return true;
      } catch (error) {
        console.error('Failed to delete project:', error);
        set({ isLoading: false });
        return false;
      }
    },

    getProject: (id) => {
      const { projects } = get();
      return projects.find((p) => p.id === id);
    },

    addRepository: async (projectId, input) => {
      set({ isLoading: true });

      try {
        const loadResult = await window.electronAPI.loadConfig();
        if (!loadResult.success || !loadResult.config) {
          throw new Error('Failed to load config');
        }

        const config = loadResult.config;
        const project = config.projects.find((p) => p.id === projectId);
        if (!project) {
          throw new Error(`Project "${projectId}" not found in config`);
        }

        // Check uniqueness within the current project only
        const existingNames = new Set(project.repos.map((r) => r.name));
        if (existingNames.has(input.name)) {
          throw new Error(`A repo named "${input.name}" already exists. Rename it or remove the existing one first.`);
        }

        const repoConfig: RepoConfigSerialized = {
          name: input.name,
          path: input.path,
        };
        project.repos.push(repoConfig);

        const saveResult = await window.electronAPI.saveConfig(config);
        if (!saveResult.success) {
          throw new Error(saveResult.error || 'Failed to save config');
        }

        const newRepository: ProjectRepository = {
          id: input.name,
          name: input.name,
          path: repoConfig.path,
          status: input.status || 'not_started',
        };

        const { projects } = get();
        const projectIdx = projects.findIndex((p) => p.id === projectId);

        if (projectIdx !== -1) {
          const updatedProject: Project = {
            ...projects[projectIdx],
            repositories: [...projects[projectIdx].repositories, newRepository],
          };
          const updatedProjects = [...projects];
          updatedProjects[projectIdx] = updatedProject;
          set({
            projects: updatedProjects,
            isLoading: false,
          });
        } else {
          set({ isLoading: false });
        }

        return newRepository;
      } catch (error) {
        console.error('Failed to add repository:', error);
        set({ isLoading: false });
        return null;
      }
    },

    removeRepository: async (projectId, repositoryId) => {
      set({ isLoading: true });

      try {
        // Load current config
        const loadResult = await window.electronAPI.loadConfig();
        if (!loadResult.success || !loadResult.config) {
          throw new Error('Failed to load config');
        }

        const config = loadResult.config;

        // Find the project and remove the repo from it
        const project = config.projects.find((p) => p.id === projectId);
        if (!project) {
          set({ isLoading: false });
          return false;
        }

        const repoIndex = project.repos.findIndex((r) => r.name === repositoryId);
        if (repoIndex === -1) {
          set({ isLoading: false });
          return false;
        }

        // Remove from project (parser/output cleanup happens via the main-process IPC)
        project.repos.splice(repoIndex, 1);

        // Save updated config
        const saveResult = await window.electronAPI.saveConfig(config);
        if (!saveResult.success) {
          throw new Error(saveResult.error || 'Failed to save config');
        }

        // Update local state
        const { projects } = get();
        const projectIdx = projects.findIndex((p) => p.id === projectId);

        if (projectIdx !== -1) {
          const updatedRepositories = projects[projectIdx].repositories.filter((r) => r.id !== repositoryId);

          const updatedProject: Project = {
            ...projects[projectIdx],
            repositories: updatedRepositories,
          };

          const updatedProjects = [...projects];
          updatedProjects[projectIdx] = updatedProject;
          set({
            projects: updatedProjects,
            isLoading: false,
          });
        } else {
          set({ isLoading: false });
        }

        return true;
      } catch (error) {
        console.error('Failed to remove repository:', error);
        set({ isLoading: false });
        return false;
      }
    },

    setProjectCloud: async (projectId, cloud) => {
      // Update config on disk
      const loadResult = await window.electronAPI.loadConfig();
      if (!loadResult.success || !loadResult.config) return;

      const config = loadResult.config;
      const projectConfig = config.projects.find((p) => p.id === projectId);
      if (projectConfig) {
        projectConfig.cloud = cloud;
        const saveResult = await window.electronAPI.saveConfig(config);
        if (!saveResult.success) return;
      }

      // Update local state only after successful disk write
      const { projects } = get();
      set({
        projects: projects.map((p) => (p.id === projectId ? { ...p, cloud } : p)),
      });
    },

    syncRepoStatus: (projectId, repoName, status) => {
      const { projects } = get();
      const updatedProjects = projects.map((project) => {
        if (project.id !== projectId) return project;

        const repoIndex = project.repositories.findIndex((r) => r.name === repoName);
        if (repoIndex === -1) return project;

        const updatedRepositories = [...project.repositories];
        updatedRepositories[repoIndex] = { ...updatedRepositories[repoIndex], status };
        return { ...project, repositories: updatedRepositories };
      });
      set({ projects: updatedProjects });
    },

    syncRepoStatusesBatch: (projectId, statuses) => {
      if (statuses.size === 0) return;
      const { projects } = get();
      let projectChanged = false;
      const updatedProjects = projects.map((project) => {
        if (project.id !== projectId) return project;

        let anyRepoChanged = false;
        const updatedRepositories = project.repositories.map((repo) => {
          const next = statuses.get(repo.name);
          if (next === undefined || next === repo.status) return repo;
          anyRepoChanged = true;
          return { ...repo, status: next };
        });

        if (!anyRepoChanged) return project;
        projectChanged = true;
        return { ...project, repositories: updatedRepositories };
      });

      // Skip the set() entirely if nothing actually changed — avoids triggering
      // re-renders (and the dropdown flicker) when the cache is already correct.
      if (projectChanged) set({ projects: updatedProjects });
    },

    syncWizardCompleted: (projectId, wizardCompleted) => {
      const { projects } = get();
      const updatedProjects = projects.map((p) =>
        p.id === projectId ? { ...p, wizardCompleted: wizardCompleted ? true : undefined } : p,
      );
      if (updatedProjects.every((p, i) => p.wizardCompleted === projects[i]?.wizardCompleted)) return;
      set({ projects: updatedProjects });
    },
  };
});
