import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RepoDetailState } from '../../shared/ipc-types';
import type { RunningCommand, WorkflowAction } from './project-detail-store';

const syncRepoStatus = vi.fn();
const syncWizardCompleted = vi.fn();

vi.mock('./projects-store', () => ({
  useProjectsStore: {
    getState: () => ({ syncRepoStatus, syncWizardCompleted }),
  },
}));

const electronAPI = {
  onCommandCompleted: vi.fn(() => () => undefined),
  getRepoDetailState: vi.fn(),
  runCommand: vi.fn(),
};

let useProjectDetailStore: typeof import('./project-detail-store').useProjectDetailStore;
let originalRunCommand: (
  repoName: string,
  action: WorkflowAction,
  args?: Record<string, unknown>,
  origin?: 'single' | 'batch',
) => Promise<void>;
let originalRefreshRepoState: (repoName: string) => Promise<void>;

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function repoState(parserExists: boolean, parsedExists: boolean): RepoDetailState {
  return {
    name: 'supabase',
    parserExists,
    parserPath: '/workspace/parsers/project/supabase/profile.ts',
    parsed: { exists: parsedExists },
    summarized: { exists: false },
    embedded: { exists: false },
    docs: { exists: false },
    neo4jSynced: { synced: false },
  } as RepoDetailState;
}

function running(action: RunningCommand['action'], args?: Record<string, unknown>): RunningCommand {
  return {
    id: `command-${action}`,
    repoName: 'supabase',
    action,
    startedAt: '2026-08-25T00:00:00.000Z',
    origin: 'batch',
    args,
  };
}

beforeAll(async () => {
  vi.stubGlobal('window', { electronAPI });
  ({ useProjectDetailStore } = await import('./project-detail-store'));
  originalRunCommand = useProjectDetailStore.getState().runCommand;
  originalRefreshRepoState = useProjectDetailStore.getState().refreshRepoState;
});

afterEach(() => {
  vi.clearAllMocks();
  useProjectDetailStore.setState({
    projectId: 'project',
    repoStates: new Map(),
    runningCommands: new Map(),
    expectedRepoCount: 0,
    wizardCompleted: false,
    runCommand: originalRunCommand,
    refreshRepoState: originalRefreshRepoState,
  });
});

describe('generate-to-parse transitional busy state', () => {
  it('keeps generate busy until refreshed parser facts and the chained parse are registered', async () => {
    const refresh = deferred();
    const dispatch = deferred();
    const generate = running('generate');
    const runCommand = vi.fn(() => dispatch.promise);

    useProjectDetailStore.setState({
      projectId: 'project',
      repoStates: new Map([['supabase', repoState(false, false)]]),
      runningCommands: new Map([[generate.id, generate]]),
      refreshRepoState: vi.fn(() => refresh.promise),
      runCommand,
    });

    useProjectDetailStore.getState().handleCommandCompleted({
      id: generate.id,
      success: true,
      exitCode: 0,
    });

    expect(useProjectDetailStore.getState().runningCommands.has(generate.id)).toBe(true);
    expect(runCommand).not.toHaveBeenCalled();

    refresh.resolve(undefined);
    await vi.waitFor(() => expect(runCommand).toHaveBeenCalledWith('supabase', 'parse', undefined, 'batch'));
    expect(useProjectDetailStore.getState().runningCommands.has(generate.id)).toBe(true);

    dispatch.resolve(undefined);
    await vi.waitFor(() => expect(useProjectDetailStore.getState().runningCommands.has(generate.id)).toBe(false));
  });

  it('keeps parse busy until refreshed output facts are visible', async () => {
    const refresh = deferred();
    const parse = running('parse');

    useProjectDetailStore.setState({
      projectId: 'project',
      repoStates: new Map([['supabase', repoState(true, false)]]),
      runningCommands: new Map([[parse.id, parse]]),
      refreshRepoState: vi.fn(() => refresh.promise),
    });

    useProjectDetailStore.getState().handleCommandCompleted({
      id: parse.id,
      success: true,
      exitCode: 0,
    });

    expect(useProjectDetailStore.getState().runningCommands.has(parse.id)).toBe(true);
    refresh.resolve(undefined);
    await vi.waitFor(() => expect(useProjectDetailStore.getState().runningCommands.has(parse.id)).toBe(false));
  });

  it('does not dispatch a chained summarize after the project changes during refresh', async () => {
    const refresh = deferred();
    const parse = running('parse', { chain: true });
    const runCommand = vi.fn(async () => undefined);

    useProjectDetailStore.setState({
      projectId: 'project',
      repoStates: new Map([['supabase', repoState(true, false)]]),
      runningCommands: new Map([[parse.id, parse]]),
      refreshRepoState: vi.fn(() => refresh.promise),
      runCommand,
    });

    useProjectDetailStore.getState().handleCommandCompleted({ id: parse.id, success: true, exitCode: 0 });
    useProjectDetailStore.setState({ projectId: 'other-project', runningCommands: new Map(), repoStates: new Map() });
    refresh.resolve(undefined);

    await vi.waitFor(() => expect(useProjectDetailStore.getState().projectId).toBe('other-project'));
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('drops a late repo-state response from the previously selected project', async () => {
    const response = deferred<RepoDetailState | null>();
    electronAPI.getRepoDetailState.mockReturnValueOnce(response.promise);
    useProjectDetailStore.setState({ projectId: 'project', repoStates: new Map() });

    const refresh = useProjectDetailStore.getState().refreshRepoState('supabase');
    useProjectDetailStore.setState({ projectId: 'other-project', repoStates: new Map() });
    response.resolve(repoState(true, true));
    await refresh;

    expect(useProjectDetailStore.getState().repoStates.has('supabase')).toBe(false);
  });
});

describe('runCommand project binding', () => {
  it('drops a dispatch response that arrives after the active project changes', async () => {
    const dispatch = deferred<{ id: string; started: boolean }>();
    electronAPI.runCommand.mockReturnValueOnce(dispatch.promise);
    useProjectDetailStore.setState({
      projectId: 'project',
      repoStates: new Map([['supabase', repoState(true, false)]]),
      runningCommands: new Map(),
      activeTerminalRepo: null,
      terminalRepoNames: [],
    });

    const run = originalRunCommand('supabase', 'parse');
    await vi.waitFor(() =>
      expect(electronAPI.runCommand).toHaveBeenCalledWith({
        command: 'parse',
        projectId: 'project',
        repo: 'supabase',
        args: undefined,
      }),
    );

    useProjectDetailStore.getState().setProjectId('other-project');
    dispatch.resolve({ id: 'stale-parse', started: true });
    await run;

    const state = useProjectDetailStore.getState();
    expect(state.projectId).toBe('other-project');
    expect(state.runningCommands.size).toBe(0);
    expect(state.activeTerminalRepo).toBeNull();
    expect(state.terminalRepoNames).toEqual([]);
    expect(syncRepoStatus).not.toHaveBeenCalled();
  });

  it('does not register a chained parse when its dispatch resolves after a project change', async () => {
    const dispatch = deferred<{ id: string; started: boolean }>();
    electronAPI.runCommand.mockReturnValueOnce(dispatch.promise);
    const generate = running('generate');
    const runCommand = vi.fn((...params: Parameters<typeof originalRunCommand>) => originalRunCommand(...params));

    useProjectDetailStore.setState({
      projectId: 'project',
      repoStates: new Map([['supabase', repoState(true, false)]]),
      runningCommands: new Map([[generate.id, generate]]),
      refreshRepoState: vi.fn(async () => undefined),
      runCommand,
    });

    useProjectDetailStore.getState().handleCommandCompleted({ id: generate.id, success: true, exitCode: 0 });
    await vi.waitFor(() => expect(runCommand).toHaveBeenCalledWith('supabase', 'parse', undefined, 'batch'));

    useProjectDetailStore.getState().setProjectId('other-project');
    dispatch.resolve({ id: 'stale-chained-parse', started: true });
    await runCommand.mock.results[0].value;
    await Promise.resolve();

    const state = useProjectDetailStore.getState();
    expect(state.projectId).toBe('other-project');
    expect(state.runningCommands.size).toBe(0);
    expect(state.terminalRepoNames).toEqual([]);
    expect(electronAPI.runCommand).toHaveBeenCalledTimes(1);
  });
});
