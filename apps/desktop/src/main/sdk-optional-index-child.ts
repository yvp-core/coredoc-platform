/** Trusted optional-indexer bootstrap. Never loads an extraction profile. */
import { createWriteStream } from 'node:fs';
import { copyOptionalScip, validateOptionalIndexRequest } from '@coredoc/profile-parser/optional-index';
import {
  installRubyTool,
  installedRubyTool,
  rubyScipPrereqs,
  rubyToolRelease,
} from '@coredoc/profile-parser/ruby-install';
import { installPythonTool, installedPythonTool, pythonScipPrereqs } from '@coredoc/profile-parser/python-install';
import { runScipPython } from '@coredoc/profile-parser/python-tools';
import { runScipRust, rustScipPrereqs } from '@coredoc/profile-parser/rust-tools';
import { runScipGo, goScipPrereqs } from '@coredoc/profile-parser/go-tools';
import { runScipRuby } from '@coredoc/profile-parser/ruby-tools';

const protocol = createWriteStream('', { fd: 3, autoClose: false });
const controller = new AbortController();
process.once('SIGTERM', () => controller.abort());
process.once('disconnect', () => controller.abort());
protocol.on('error', () => controller.abort());
const post = (message: unknown) => protocol.write(`${JSON.stringify(message)}\n`);
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', () => {
  void run();
});

async function run() {
  try {
    const { repoRoot, artifactPath, request: raw } = JSON.parse(input);
    const request = validateOptionalIndexRequest(raw);
    const tool =
      request.language === 'ruby'
        ? {
            label: 'Ruby',
            prerequisites: rubyScipPrereqs,
            run: runScipRuby,
            install: installRubyTool,
            canInstall: () => {
              try {
                rubyToolRelease();
                return !installedRubyTool(repoRoot);
              } catch {
                return false;
              }
            },
          }
        : request.language === 'python'
          ? {
              label: 'Python',
              prerequisites: pythonScipPrereqs,
              run: runScipPython,
              install: installPythonTool,
              canInstall: () => ['darwin', 'linux'].includes(process.platform) && !installedPythonTool(repoRoot),
            }
          : request.language === 'rust'
            ? {
                label: 'Rust',
                prerequisites: rustScipPrereqs,
                run: runScipRust,
                install: undefined,
                canInstall: () => false,
              }
            : {
                label: 'Go',
                prerequisites: goScipPrereqs,
                run: runScipGo,
                install: undefined,
                canInstall: () => false,
              };
    let error: string | undefined;
    for (;;) {
      controller.signal.throwIfAborted();
      const issue = error ?? tool.prerequisites(repoRoot);
      if (!issue) break;
      const choice = await new Promise<unknown>((resolve, reject) => {
        const abort = () => {
          process.off('message', receive);
          reject(controller.signal.reason);
        };
        const receive = (message: unknown) => {
          controller.signal.removeEventListener('abort', abort);
          resolve(message);
        };
        controller.signal.addEventListener('abort', abort, { once: true });
        process.once('message', receive);
        post({ type: 'prerequisites', message: issue, canInstall: tool.canInstall() });
      });
      if (choice === 'basic' && request.fallback) {
        post({ type: 'result', basic: true });
        return;
      }
      if (choice === 'install' && tool.install && tool.canInstall()) {
        try {
          await tool.install(repoRoot, {
            signal: controller.signal,
            onLog: console.info,
            onProgress(received, total) {
              post({
                type: 'install-progress',
                message: `Downloading ${tool.label} indexer: ${(received / 1_000_000).toFixed(1)}${total ? ` of ${(total / 1_000_000).toFixed(1)}` : ''} MB`,
              });
            },
          });
          post({ type: 'install-complete' });
          error = undefined;
        } catch (cause) {
          controller.signal.throwIfAborted();
          error = cause instanceof Error ? cause.message : String(cause);
        }
      } else if (choice === 'retry') error = undefined;
      else throw new DOMException('Analysis cancelled', 'AbortError');
    }
    const result = await tool.run(repoRoot, { signal: controller.signal, onLog: console.info });
    const index = ('scip' in result ? result.scip : undefined) ?? result.scipPath;
    if (!result.ok || !index) throw new Error(result.degradeReason ?? `${tool.label} indexer produced no index.`);
    copyOptionalScip(index, artifactPath);
    post({ type: 'result', path: artifactPath });
  } catch (error) {
    post({ type: 'result', error: error instanceof Error ? error.message : String(error) });
  } finally {
    protocol.end();
    process.removeAllListeners('disconnect');
    process.disconnect?.();
  }
}
