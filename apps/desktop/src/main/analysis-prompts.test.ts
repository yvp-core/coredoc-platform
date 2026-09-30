import { describe, expect, it, vi } from 'vitest';
import {
  answerAnalysisPrompt,
  askAnalysisPrompt,
  getAnalysisPrompts,
  showAnalysisProgress,
} from './analysis-prompts.js';
const details = { commandId: 'cmd', projectId: 'project', repoName: 'api', message: 'Missing SDK', canUseBasic: true };
describe('analysis prompt lifecycle', () => {
  it('survives renderer reload and refuses stale replies', async () => {
    const changed = vi.fn();
    const pending = askAnalysisPrompt(details, new AbortController().signal, changed);
    const [prompt] = getAnalysisPrompts();
    expect(prompt).toMatchObject(details);
    expect(answerAnalysisPrompt(prompt.id, 'basic')).toBe(true);
    expect(await pending).toBe('basic');
    expect(getAnalysisPrompts()).toEqual([]);
    expect(answerAnalysisPrompt(prompt.id, 'retry')).toBe(false);
    expect(changed).toHaveBeenCalledTimes(2);
  });
  it('does not allow basic for a strict profile and clears cancelled requests', async () => {
    const controller = new AbortController();
    const pending = askAnalysisPrompt({ ...details, canUseBasic: false }, controller.signal, vi.fn());
    const [prompt] = getAnalysisPrompts();
    expect(answerAnalysisPrompt(prompt.id, 'basic')).toBe(false);
    expect(answerAnalysisPrompt(prompt.id, 'install')).toBe(false);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(getAnalysisPrompts()).toEqual([]);
  });
  it('accepts explicit installation only for a host-provided installable prompt', async () => {
    const pending = askAnalysisPrompt({ ...details, canInstall: true }, new AbortController().signal, vi.fn());
    const [prompt] = getAnalysisPrompts();
    expect(answerAnalysisPrompt(prompt.id, 'install')).toBe(true);
    expect(await pending).toBe('install');
  });
});

it('keeps an installation visible through reload, allows only explicit cancellation, and cleans up', () => {
  const cancel = vi.fn();
  const clear = showAnalysisProgress(details, cancel, vi.fn());
  const [prompt] = getAnalysisPrompts();
  expect(prompt.phase).toBe('installing');
  expect(answerAnalysisPrompt(prompt.id, 'retry')).toBe(false);
  expect(answerAnalysisPrompt(prompt.id, 'basic')).toBe(false);
  expect(answerAnalysisPrompt(prompt.id, 'cancel')).toBe(true);
  expect(cancel).toHaveBeenCalledOnce();
  clear();
  expect(getAnalysisPrompts()).toEqual([]);
});
it('execution consent accepts only run, basic or cancel', async () => {
  const pending = askAnalysisPrompt({ ...details, phase: 'execution' }, new AbortController().signal, vi.fn());
  const [prompt] = getAnalysisPrompts();
  expect(answerAnalysisPrompt(prompt.id, 'retry')).toBe(false);
  expect(answerAnalysisPrompt(prompt.id, 'install')).toBe(false);
  expect(answerAnalysisPrompt(prompt.id, 'run')).toBe(true);
  expect(await pending).toBe('run');
});

it('keeps concurrent indexer downloads visible independently within one monorepo parse', () => {
  const clearCSharp = showAnalysisProgress({ ...details, language: 'csharp' }, vi.fn(), vi.fn());
  const clearPython = showAnalysisProgress({ ...details, language: 'python' }, vi.fn(), vi.fn());
  try {
    expect(getAnalysisPrompts().map((prompt) => prompt.language)).toEqual(['csharp', 'python']);
    clearCSharp();
    expect(getAnalysisPrompts().map((prompt) => prompt.language)).toEqual(['python']);
  } finally {
    clearCSharp();
    clearPython();
  }
});
