// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TeamMcpReleaseTriggerStep } from './TeamMcpReleaseTriggerStep';
import { useWorkspaceStore } from '../../stores/workspace-store';

const setIntentReleaseTrigger = vi.fn(async () => undefined);
const setProductionBranch = vi.fn(async () => undefined);
const listWorkspaces = vi.fn(async (): Promise<unknown[]> => []);
const listRepos = vi.fn(async () => useWorkspaceStore.getState().repos);
const setRepoReleaseTrigger = vi.fn(async () => undefined);

// The step invalidates the Releases header's query after the PATCH, so it needs
// the same provider the Intent panel gives it in the app.
const render = (ui: ReactElement) =>
  rtlRender(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      {ui}
    </QueryClientProvider>,
  );

function seed(trigger: string, repoTrigger: string | null = null, intentEnabled = true) {
  // The step reads the trigger through the Releases header's query, not the
  // store copy, so the workspace list is what decides what it renders.
  listWorkspaces.mockResolvedValue([{ id: 'ws1', intentReleaseTrigger: trigger }]);
  useWorkspaceStore.setState({
    selectedWorkspaceId: 'ws1',
    workspaces: [
      {
        id: 'ws1',
        name: 'Acme',
        slug: 'acme',
        createdAt: '2026-09-01T00:00:00Z',
        intentReleaseTrigger: trigger,
        intentEnabled,
      },
    ] as never,
    repos: [
      {
        id: 'r1',
        repoKey: 'backend',
        repoName: 'backend',
        gitUrl: null,
        intentReleaseTrigger: repoTrigger,
        createdAt: '2026-09-01T00:00:00Z',
      },
    ] as never,
  });
}

beforeEach(() => {
  setIntentReleaseTrigger.mockClear();
  setProductionBranch.mockClear();
  setRepoReleaseTrigger.mockClear();
  listRepos.mockClear();
  listWorkspaces.mockReset();
  listWorkspaces.mockResolvedValue([]);
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      workspaceSetIntentReleaseTrigger: setIntentReleaseTrigger,
      workspaceSetProductionBranch: setProductionBranch,
      workspaceSetRepoReleaseTrigger: setRepoReleaseTrigger,
      workspaceListWorkspaces: listWorkspaces,
      workspaceListRepos: listRepos,
    },
  });
});
afterEach(cleanup);

describe('Intent release trigger setting', () => {
  it('overrides a manual default for one repository and can restore inheritance', async () => {
    seed('manual', 'merge');
    render(<TeamMcpReleaseTriggerStep workspaceId="ws1" />);
    const selector = await screen.findByRole('combobox', { name: 'Release trigger for backend' });
    await waitFor(() => expect(selector).toBeEnabled());
    fireEvent.keyDown(selector, { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('option', { name: 'On deploy' }));
    await waitFor(() => expect(setRepoReleaseTrigger).toHaveBeenCalledWith('ws1', 'backend', 'deploy'));
    expect(await screen.findByRole('textbox', { name: 'Production branch for backend' })).toBeInTheDocument();
    await waitFor(() => expect(selector).toBeEnabled());
    fireEvent.keyDown(selector, { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('option', { name: 'Default (Manual)' }));
    await waitFor(() => expect(setRepoReleaseTrigger).toHaveBeenCalledWith('ws1', 'backend', null));
  });

  it('sends the chosen trigger for the selected workspace', async () => {
    seed('manual');
    render(<TeamMcpReleaseTriggerStep workspaceId="ws1" />);
    expect(await screen.findByText('Deliveries are recorded here, by a maintainer.')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Intent release trigger' })).toBeEnabled());
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Intent release trigger' }), { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('option', { name: 'On deploy' }));
    await waitFor(() => expect(setIntentReleaseTrigger).toHaveBeenCalledWith('ws1', 'deploy'));
  });

  it('offers a production branch per repository only in an automatic mode', async () => {
    seed('manual');
    const view = render(<TeamMcpReleaseTriggerStep workspaceId="ws1" />);
    expect(await screen.findByText('Deliveries are recorded here, by a maintainer.')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Production branch for backend' })).not.toBeInTheDocument();
    view.unmount();

    seed('merge');
    render(<TeamMcpReleaseTriggerStep workspaceId="ws1" />);
    const branch = await screen.findByRole('textbox', { name: 'Production branch for backend' });
    fireEvent.change(branch, { target: { value: 'release' } });
    fireEvent.blur(branch);
    await waitFor(() => expect(setProductionBranch).toHaveBeenCalledWith('ws1', 'backend', 'release'));
  });

  it('clears the override when the branch field is emptied', async () => {
    useWorkspaceStore.setState({
      selectedWorkspaceId: 'ws1',
      workspaces: [
        {
          id: 'ws1',
          name: 'Acme',
          slug: 'acme',
          createdAt: '2026-09-01T00:00:00Z',
          intentReleaseTrigger: 'merge',
          intentEnabled: true,
        },
      ] as never,
      repos: [
        {
          id: 'r1',
          repoKey: 'backend',
          repoName: 'backend',
          gitUrl: null,
          productionBranch: 'main',
          createdAt: '2026-09-01T00:00:00Z',
        },
      ],
    });
    listWorkspaces.mockResolvedValue([{ id: 'ws1', intentReleaseTrigger: 'merge' }]);
    render(<TeamMcpReleaseTriggerStep workspaceId="ws1" />);
    const branch = await screen.findByRole('textbox', { name: 'Production branch for backend' });
    fireEvent.change(branch, { target: { value: '' } });
    fireEvent.blur(branch);
    await waitFor(() => expect(setProductionBranch).toHaveBeenCalledWith('ws1', 'backend', null));
  });

  it('says intent is off and reads nothing when the workspace has it disabled', async () => {
    seed('merge', null, false);
    render(<TeamMcpReleaseTriggerStep workspaceId="ws1" />);

    expect(await screen.findByText('Intent is not enabled for this workspace.')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Intent release trigger' })).not.toBeInTheDocument();
    expect(listWorkspaces).not.toHaveBeenCalled();
    expect(listRepos).not.toHaveBeenCalled();
  });

  it('hides the repository section under a manual default with nothing overridden', async () => {
    seed('manual');
    render(<TeamMcpReleaseTriggerStep workspaceId="ws1" />);

    expect(await screen.findByText('Deliveries are recorded here, by a maintainer.')).toBeInTheDocument();
    expect(screen.queryByText('Repository overrides and production branches')).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Release trigger for backend' })).not.toBeInTheDocument();
  });

  it('disables the selector and says unavailable when the trigger read fails', async () => {
    seed('merge');
    listWorkspaces.mockRejectedValue(new Error('offline'));
    render(<TeamMcpReleaseTriggerStep workspaceId="ws1" />);

    expect(await screen.findByText('Release trigger unavailable')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Intent release trigger' })).toBeDisabled();
    // A stale value must not be offered for editing either.
    expect(screen.queryByRole('textbox', { name: 'Production branch for backend' })).not.toBeInTheDocument();
  });
});
