import { randomUUID } from 'node:crypto';
import type { AnalysisPrompt, AnalysisChoice } from '../shared/ipc-types.js';

const pending = new Map<string, { prompt: AnalysisPrompt; answer: (choice: AnalysisChoice) => void }>();
export function getAnalysisPrompts(): AnalysisPrompt[] {
  return [...pending.values()].map((entry) => entry.prompt);
}
export function answerAnalysisPrompt(id: string, choice: unknown): boolean {
  const entry = pending.get(id);
  if (
    !entry ||
    !['retry', 'basic', 'cancel', 'install', 'run'].includes(String(choice)) ||
    (entry.prompt.phase === 'installing' && choice !== 'cancel') ||
    (choice === 'run' && entry.prompt.phase !== 'execution') ||
    (choice === 'retry' && entry.prompt.phase === 'execution') ||
    (choice === 'install' && !entry.prompt.canInstall) ||
    (choice === 'basic' && !entry.prompt.canUseBasic)
  )
    return false;
  entry.answer(choice as AnalysisChoice);
  return true;
}
export function askAnalysisPrompt(
  details: Omit<AnalysisPrompt, 'id'>,
  signal: AbortSignal,
  changed: () => void,
): Promise<AnalysisChoice> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const cleanup = () => {
      pending.delete(id);
      signal.removeEventListener('abort', abort);
      changed();
    };
    const abort = () => {
      cleanup();
      reject(new DOMException('Analysis cancelled', 'AbortError'));
    };
    pending.set(id, {
      prompt: { ...details, id },
      answer: (choice) => {
        cleanup();
        resolve(choice);
      },
    });
    signal.addEventListener('abort', abort, { once: true });
    changed();
  });
}

/** Progress stays in the main process so a renderer reload cannot hide an active download. */
export function showAnalysisProgress(
  details: Omit<AnalysisPrompt, 'id' | 'phase' | 'canInstall' | 'canUseBasic'>,
  cancel: () => void,
  changed: () => void,
): () => void {
  const id = `install:${randomUUID()}`;
  pending.set(id, {
    prompt: { ...details, id, phase: 'installing', canUseBasic: false },
    answer: cancel,
  });
  changed();
  return () => {
    pending.delete(id);
    changed();
  };
}
