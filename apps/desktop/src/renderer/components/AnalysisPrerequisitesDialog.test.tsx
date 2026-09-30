// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnalysisPrerequisitesDialog } from './AnalysisPrerequisitesDialog';
import { AnalysisStatus } from './AnalysisStatus';
import { TooltipProvider } from './ui/tooltip';
afterEach(cleanup);
describe('analysis UI', () => {
  it('restores a pending choice, retries and skips through IPC', async () => {
    const prompt = {
      id: 'prompt',
      commandId: 'cmd',
      projectId: 'proj',
      repoName: 'api',
      message: 'scip-dotnet is missing',
      canUseBasic: true,
      canInstall: true,
    };
    let changed: () => void = vi.fn();
    const getAnalysisPrompts = vi.fn().mockResolvedValue([prompt]);
    const answerAnalysisPrompt = vi.fn().mockResolvedValue(true);
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        getAnalysisPrompts,
        answerAnalysisPrompt,
        onAnalysisPromptsChanged: (cb: () => void) => {
          changed = cb;
          return vi.fn();
        },
      },
    });
    render(<AnalysisPrerequisitesDialog />);
    await screen.findByText('scip-dotnet is missing');
    fireEvent.click(screen.getByText('Install C# indexer'));
    await waitFor(() => expect(answerAnalysisPrompt).toHaveBeenCalledWith('prompt', 'install'));
    await waitFor(() => expect((screen.getByText('Check again') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByText('Check again'));
    await waitFor(() => expect(answerAnalysisPrompt).toHaveBeenCalledWith('prompt', 'retry'));
    await waitFor(() => expect((screen.getByText('Use basic') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByText('Use basic'));
    await waitFor(() => expect(answerAnalysisPrompt).toHaveBeenCalledWith('prompt', 'basic'));
    getAnalysisPrompts.mockResolvedValue([]);
    await act(async () => changed());
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('discloses actual fallback through the compact indicator and its keyboard tooltip', async () => {
    render(
      <TooltipProvider>
        <AnalysisStatus
          analysis={[{ language: 'csharp', mode: 'basic', fallback: true, compilerReceiverTypes: false }]}
        />
      </TooltipProvider>,
    );
    const indicator = screen.getByRole('button', { name: 'Analysis: C# · basic (fallback)' });
    expect(indicator.textContent).toBe('');
    fireEvent.focus(indicator);
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip.textContent).toContain('C# · basic (fallback)');
    expect(tooltip.textContent).toContain('Enhanced analysis was unavailable. The graph uses basic analysis.');
  });
});

it('requires a button choice, keeps install progress visible, and reports IPC errors with an existing token', async () => {
  let changed: () => void = vi.fn();
  const prompt = {
    id: 'p',
    commandId: 'c',
    projectId: 'proj',
    repoName: 'api',
    message: 'Build targets use network access',
    canUseBasic: true,
    phase: 'execution',
  };
  const getAnalysisPrompts = vi.fn().mockResolvedValue([prompt]);
  const answerAnalysisPrompt = vi.fn().mockRejectedValue(new Error('IPC failed'));
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      getAnalysisPrompts,
      answerAnalysisPrompt,
      onAnalysisPromptsChanged: (cb: () => void) => {
        changed = cb;
        return vi.fn();
      },
    },
  });
  render(<AnalysisPrerequisitesDialog />);
  await screen.findByRole('button', { name: 'Run enhanced' });
  fireEvent.keyDown(document, { key: 'Escape' });
  fireEvent.pointerDown(document.body);
  expect(answerAnalysisPrompt).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Run enhanced' }));
  const error = await screen.findByRole('alert');
  expect(error.className).toContain('text-content-warning');
  getAnalysisPrompts.mockResolvedValue([
    { ...prompt, phase: 'installing', canUseBasic: false, message: 'Downloading: 3.0 of 18.0 MB' },
  ]);
  await act(async () => changed());
  expect(screen.getByRole('heading', { name: 'Installing C# indexer' })).toBeDefined();
  expect(screen.getByText('Downloading: 3.0 of 18.0 MB')).toBeDefined();
  expect(screen.queryByRole('button', { name: 'Check again' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Use basic' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Cancel analysis' })).toBeDefined();
});
