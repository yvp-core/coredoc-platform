import { afterEach, beforeEach, expect, it, vi } from 'vitest';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const config = { projects: [{ id: 'local', name: 'Local workspace', repos: [{ name: 'api', path: '/api' }] }] };
let useProjectsStore: typeof import('./projects-store').useProjectsStore;
const electronAPI = {
  loadConfig: vi.fn(),
  getRepoStatusState: vi.fn(),
  getRepoDetailState: vi.fn(),
  getWorkspaceAuthStatus: vi.fn(),
  workspaceListWorkspaces: vi.fn(),
  workspaceListRepos: vi.fn(),
};
beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal('window', { electronAPI });
  electronAPI.loadConfig.mockResolvedValue({ success: true, config });
  ({ useProjectsStore } = await import('./projects-store'));
});

it('keeps a newer running status when the initial status request finishes', async () => {
  const status = deferred<unknown>();
  electronAPI.getRepoStatusState.mockReturnValue(status.promise);
  const loading = useProjectsStore.getState().loadLocalProjects();
  await vi.waitFor(() => expect(useProjectsStore.getState().initialized).toBe(true));
  useProjectsStore.getState().syncRepoStatus('local', 'api', 'parsing');
  status.resolve({
    parserExists: false,
    parsed: { exists: false },
    summarized: { exists: false },
    neo4jSynced: { synced: false },
  });
  await loading;
  expect(useProjectsStore.getState().projects[0]?.repositories[0]?.status).toBe('parsing');
});

it.each(['reject', 'null'] as const)('settles a %s status check and recovers on reload', async (failure) => {
  if (failure === 'reject') electronAPI.getRepoStatusState.mockRejectedValueOnce(new Error('IPC unavailable'));
  else electronAPI.getRepoStatusState.mockResolvedValueOnce(null);
  await useProjectsStore.getState().loadLocalProjects();
  expect(useProjectsStore.getState().projects[0]?.repositories[0]?.status).toBe('status_unavailable');

  electronAPI.getRepoStatusState.mockResolvedValueOnce({
    parserExists: true,
    parsed: { exists: true },
    summarized: { exists: false },
    neo4jSynced: { synced: false },
    approval: { approved: true, isStale: false },
  });
  await useProjectsStore.getState().loadLocalProjects();
  expect(useProjectsStore.getState().projects[0]?.repositories[0]?.status).toBe('approved');
});

it('keeps the last known status when its refresh fails', async () => {
  electronAPI.getRepoStatusState.mockResolvedValueOnce({
    parserExists: true,
    parsed: { exists: true },
    summarized: { exists: false },
    neo4jSynced: { synced: false },
    approval: { approved: true, isStale: false },
  });
  await useProjectsStore.getState().loadLocalProjects();
  electronAPI.getRepoStatusState.mockRejectedValueOnce(new Error('IPC unavailable'));
  await useProjectsStore.getState().loadLocalProjects();
  expect(useProjectsStore.getState().projects[0]?.repositories[0]?.status).toBe('approved');
});

it('does not overwrite a newer running status after a failed check', async () => {
  const status = deferred<null>();
  electronAPI.getRepoStatusState.mockReturnValueOnce(status.promise);
  const loading = useProjectsStore.getState().loadLocalProjects();
  await vi.waitFor(() => expect(useProjectsStore.getState().initialized).toBe(true));
  useProjectsStore.getState().syncRepoStatus('local', 'api', 'parsing');
  status.resolve(null);
  await loading;
  expect(useProjectsStore.getState().projects[0]?.repositories[0]?.status).toBe('parsing');
});

it('does not restore old local statuses when cloud loading finishes later', async () => {
  electronAPI.getRepoStatusState.mockResolvedValue({
    parserExists: false,
    parsed: { exists: false },
    summarized: { exists: false },
    neo4jSynced: { synced: false },
  });
  await useProjectsStore.getState().loadLocalProjects();
  electronAPI.getWorkspaceAuthStatus.mockResolvedValue({ isLoggedIn: true });
  const workspaces = deferred<unknown[]>();
  electronAPI.workspaceListWorkspaces.mockReturnValue(workspaces.promise);
  const cloudLoading = useProjectsStore.getState().loadCloudProjects();
  await vi.waitFor(() => expect(electronAPI.workspaceListWorkspaces).toHaveBeenCalled());
  useProjectsStore.getState().syncRepoStatus('local', 'api', 'approved');
  workspaces.resolve([]);
  await cloudLoading;
  expect(useProjectsStore.getState().projects[0]?.repositories[0]?.status).toBe('approved');
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it('shows workspaces before status calls finish and merges statuses without removing cloud workspaces', async () => {
  const status = deferred<unknown>();
  electronAPI.getRepoStatusState.mockReturnValue(status.promise);
  electronAPI.getRepoDetailState.mockReturnValue(status.promise);
  const loading = useProjectsStore.getState().loadLocalProjects();
  await vi.waitFor(() => expect(useProjectsStore.getState().initialized).toBe(true));
  expect(useProjectsStore.getState().isLoadingLocal).toBe(false);
  expect(useProjectsStore.getState().projects[0]?.name).toBe('Local workspace');
  expect(useProjectsStore.getState().projects[0]?.repositories[0]?.status).toBe('checking');
  expect(electronAPI.getRepoDetailState).not.toHaveBeenCalled();
  useProjectsStore.setState(({ projects }) => ({
    projects: [
      ...projects,
      {
        id: 'cloud:other',
        name: 'Other',
        createdAt: '',
        repositories: [],
        cloudMember: { workspaceId: 'other' },
      },
    ],
  }));
  status.resolve({
    parserExists: true,
    parsed: { exists: true },
    summarized: { exists: false },
    neo4jSynced: { synced: true },
    staleness: { isStale: true },
  });
  await loading;
  expect(useProjectsStore.getState().projects.map((p) => p.id)).toEqual(['local', 'cloud:other']);
  expect(useProjectsStore.getState().projects[0]?.repositories[0]?.status).toBe('graph_needs_update');
});
