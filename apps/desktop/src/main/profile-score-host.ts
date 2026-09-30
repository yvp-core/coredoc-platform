import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateCSharpIndexRequest, type CSharpIndexResponse } from '@coredoc/profile-parser/csharp';
import { prepareDesktopCSharpIndex, type CSharpHostOptions } from './csharp-index-host.js';
import { spawnSandboxedParse, type SandboxedParseLaunchOptions } from './profile-parse-sandbox.js';
import { validateOptionalIndexRequest } from '@coredoc/profile-parser/optional-index';
import { prepareDesktopOptionalIndex } from './optional-index-host.js';

interface ProfileScoreHostOptions {
  profilePath: string;
  mode?: () => 'basic' | 'enhanced' | undefined;
  controller: AbortController;
  compiler: Omit<CSharpHostOptions, 'artifactDir' | 'signal'>;
  sandbox: Omit<
    SandboxedParseLaunchOptions,
    | 'message'
    | 'prepareCSharpIndex'
    | 'prepareOptionalIndex'
    | 'onLog'
    | 'onResult'
    | 'onError'
    | 'onClose'
    | 'databaseUrl'
  >;
}

/** A generation run owns its compiler consent and index; neither is supplied by the agent. */
export function createProfileScoreHost(options: ProfileScoreHostOptions) {
  const artifactDir = mkdtempSync(join(tmpdir(), 'coredoc-authoring-index-'));
  const indexes = new Map<string, Promise<CSharpIndexResponse>>();
  const optionalIndexes = new Map<string, Promise<CSharpIndexResponse>>();
  let attempts = 0;
  let lastBlocker = '';
  let repeatedBlockers = 0;
  let running = false;
  const prepare = (raw: unknown) => {
    const request = validateCSharpIndexRequest(raw);
    if (options.mode?.() === 'basic') {
      if (!request.fallback) throw new Error('This profile requires enhanced analysis but basic was selected.');
      return Promise.resolve({ basic: true } as const);
    }
    const key = JSON.stringify({
      ...request,
      projects: [...request.projects].sort(),
      defines: [...request.defines].sort(),
    });
    let index = indexes.get(key);
    if (!index) {
      index = prepareDesktopCSharpIndex(request, {
        ...options.compiler,
        artifactDir,
        signal: options.controller.signal,
      });
      indexes.set(key, index);
      void index.catch(() => indexes.delete(key));
    }
    return index;
  };
  const prepareOptional = (raw: unknown) => {
    const request = validateOptionalIndexRequest(raw);
    if (options.mode?.() === 'basic') {
      if (!request.fallback) throw new Error('This profile requires enhanced analysis but basic was selected.');
      return Promise.resolve({ basic: true } as const);
    }
    const key = JSON.stringify(request);
    let index = optionalIndexes.get(key);
    if (!index) {
      index = prepareDesktopOptionalIndex(request, {
        ...options.compiler,
        artifactDir,
        signal: options.controller.signal,
        ask: (message, canUseBasic, canInstall, phase) =>
          options.compiler.ask(message, canUseBasic, canInstall, phase, request.language),
        onProgress: (message) => options.compiler.onProgress(message, request.language),
      });
      optionalIndexes.set(key, index);
      void index.then(
        (result) => {
          if ('basic' in result) optionalIndexes.delete(key);
        },
        () => optionalIndexes.delete(key),
      );
    }
    return index;
  };
  return {
    artifactDir,
    prepareIndex: prepare,
    prepareOptionalIndex: prepareOptional,
    beginParse() {
      // The source may have changed since the last score, even when the profile is identical.
      optionalIndexes.clear();
    },
    async score(): Promise<{ success: boolean; output: string }> {
      options.controller.signal.throwIfAborted();
      if (running) return { success: false, output: 'A profile score is already running. Wait for its result.' };
      // These indexes carry coordinates but no source-hash manifest. Share only within this
      // score; the checkout may have changed before the next revision is scored.
      optionalIndexes.clear();
      attempts += 1;
      running = true;
      options.compiler.onLog(`Profile score ${attempts}\n`);
      try {
        let scorerError = '';
        const result = await new Promise<{ success: boolean; output: string }>((resolve, reject) => {
          let output = '';
          let success = false;
          let failure: Error | undefined;
          const handle = spawnSandboxedParse({
            ...options.sandbox,
            readPaths: [...options.sandbox.readPaths, artifactDir],
            databaseUrl: `file:${join(artifactDir, 'score.db')}`,
            message: {
              command: 'score-profile',
              profilePath: options.profilePath,
              repoRoot: options.compiler.repoRoot,
            },
            prepareCSharpIndex: prepare,
            prepareOptionalIndex: prepareOptional,
            onLog(text) {
              output += text;
              options.compiler.onLog(text);
            },
            onResult(result) {
              success = result.success;
              if (result.error) {
                scorerError = result.error;
                output += `\n${result.error}`;
              }
            },
            onError(error) {
              failure = error;
            },
            onClose() {
              options.controller.signal.removeEventListener('abort', abort);
              if (options.controller.signal.aborted) reject(options.controller.signal.reason);
              else if (failure) reject(failure);
              else resolve({ success, output });
            },
          });
          const abort = () => handle.terminate();
          options.controller.signal.addEventListener('abort', abort, { once: true });
          if (options.controller.signal.aborted) abort();
        });
        // Timings, report paths and unchanged successful categories are not progress.
        // Keep the scorer's actual category counts/errors, so an improving large repo
        // can take more attempts without being mistaken for the stalled loop.
        const blocker = result.output.includes('=== Profile completion: BLOCKED ===')
          ? result.output
              .split('\n')
              .filter((line) => /^(?: {2}- | {2}RED:|===== Target:)/.test(line))
              .join('\n') || 'BLOCKED'
          : !result.success && scorerError
            ? `scorer-error:${scorerError}`
            : '';
        repeatedBlockers = blocker && blocker === lastBlocker ? repeatedBlockers + 1 : blocker ? 1 : 0;
        lastBlocker = blocker;
        if (repeatedBlockers >= 3) {
          const reason = new Error(
            'Profile generation stopped after the same blocking diagnostics repeated 3 times without improvement. The draft is saved for retry; the analyzer or profile instructions need investigation.',
          );
          options.compiler.onLog(`${reason.message}\n`);
          options.controller.abort(reason);
        }
        return result;
      } finally {
        running = false;
      }
    },
    async dispose() {
      options.controller.abort();
      await Promise.allSettled([...indexes.values(), ...optionalIndexes.values()]);
      rmSync(artifactDir, { recursive: true, force: true });
    },
  };
}
