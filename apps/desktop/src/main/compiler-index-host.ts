import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { stripVTControlCharacters } from 'node:util';
import type { AnalysisChoice, AnalysisPrompt } from '../shared/ipc-types.js';

export interface CompilerHostOptions {
  repoRoot: string;
  artifactDir: string;
  nodeExecutable: string;
  sourceEnv: NodeJS.ProcessEnv;
  signal: AbortSignal;
  onLog: (message: string) => void;
  onProgress: (message: string | undefined, language?: string) => void;
  ask: (
    message: string,
    canUseBasic: boolean,
    canInstall: boolean,
    phase: AnalysisPrompt['phase'],
    language?: string,
  ) => Promise<AnalysisChoice>;
}

export type CompilerIndexResponse = { path: string } | { basic: true };

const LOG_BYTES = 256 * 1024;
const PROTOCOL_FRAME_BYTES = 64 * 1024;
const PROTOCOL_TOTAL_BYTES = 1024 * 1024;
// Strip complete terminal sequences and neutralize split ESC/OSC sequences before renderer IPC.
const plainText = (text: string) =>
  stripVTControlCharacters(text).replace(/\p{Cc}/gu, (char) => (char === '\n' || char === '\t' ? char : ''));

/** Wrappers validate language-specific input; executable and environment remain host-owned. */
export async function prepareDesktopCompilerIndex(
  request: { fallback: boolean },
  options: CompilerHostOptions,
  tool: { label: string; notice: string; childScript: string },
): Promise<CompilerIndexResponse> {
  options.signal.throwIfAborted();
  // Installed tools are not permission to execute a newly added repository's build targets.
  const consent = await options.ask(tool.notice, request.fallback, false, 'execution');
  options.signal.throwIfAborted();
  if (consent === 'basic' && request.fallback) return { basic: true };
  if (consent !== 'run') throw new DOMException('Analysis cancelled', 'AbortError');
  const artifactPath = join(mkdtempSync(join(options.artifactDir, 'target-')), 'index.scip');
  return new Promise((resolve, reject) => {
    const child = spawn(options.nodeExecutable, [tool.childScript], {
      cwd: options.artifactDir,
      // No provider credentials, NODE_OPTIONS, package hooks or profile-controlled environment.
      env: Object.fromEntries(
        [
          'PATH',
          'HOME',
          'TMPDIR',
          'ELECTRON_RUN_AS_NODE',
          'COREDOC_HOME',
          'COREDOC_SCIP_DOTNET',
          'COREDOC_RUNTIME_MODULES',
          'RUSTUP_HOME',
        ].flatMap((key) => (options.sourceEnv[key] ? [[key, options.sourceEnv[key]!]] : [])),
      ),
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'ipc'],
    });
    let result: CompilerIndexResponse | undefined;
    let failure: Error | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let deadline: NodeJS.Timeout | undefined;
    let logBytes = 0;
    let logTruncated = false;
    const log = (message: string) => {
      if (logTruncated) return;
      const bytes = Buffer.from(message);
      const available = LOG_BYTES - logBytes;
      logBytes += Math.min(bytes.length, available);
      const text = plainText(new StringDecoder('utf8').write(bytes.subarray(0, available)));
      if (text) options.onLog(text);
      if (bytes.length > available) {
        logTruncated = true;
        options.onLog('\n[Compiler output truncated after 256 KiB.]\n');
      }
    };
    const kill = (signal: NodeJS.Signals) => {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        child.kill(signal);
      }
    };
    const abort = () => {
      if (killTimer) return;
      kill('SIGTERM');
      killTimer = setTimeout(() => kill('SIGKILL'), 1_000);
      killTimer.unref();
    };
    const startDeadline = () => {
      clearTimeout(deadline);
      // Human decisions are untimed. Bound unattended work even if the bootstrap stops replying.
      deadline = setTimeout(() => {
        failure = new Error(`${tool.label} compiler preparation timed out after 30 minutes.`);
        abort();
      }, 30 * 60_000);
      deadline.unref();
    };
    startDeadline();
    options.signal.addEventListener('abort', abort, { once: true });
    if (options.signal.aborted) abort();
    let buffer = '';
    let protocolBytes = 0;
    const protocol = child.stdio[3] as Readable;
    protocol.setEncoding('utf8');
    const fail = (error: Error) => {
      failure ??= error;
      abort();
    };
    protocol.on('error', fail);
    protocol.on('data', (chunk: string) => {
      if (failure) return;
      protocolBytes += Buffer.byteLength(chunk);
      if (protocolBytes > PROTOCOL_TOTAL_BYTES) {
        buffer = '';
        log('[Compiler protocol truncated: total output limit exceeded.]');
        fail(new Error('Compiler protocol exceeded its 1 MiB output limit.'));
        return;
      }
      buffer += chunk;
      for (;;) {
        const end = buffer.indexOf('\n');
        if (Buffer.byteLength(end < 0 ? buffer : buffer.slice(0, end)) > PROTOCOL_FRAME_BYTES) {
          buffer = '';
          log('[Compiler protocol truncated: message limit exceeded.]');
          fail(new Error('Compiler protocol message exceeded its 64 KiB limit.'));
          return;
        }
        if (end < 0) break;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          const message = JSON.parse(line);
          if (message.type === 'prerequisites') {
            clearTimeout(deadline);
            options.onProgress(undefined);
            void options
              .ask(plainText(String(message.message)), request.fallback, message.canInstall === true, 'prerequisites')
              .then((choice) => {
                if (options.signal.aborted) return;
                if (choice === 'cancel') {
                  fail(new DOMException('Analysis cancelled', 'AbortError'));
                } else if (child.connected) {
                  startDeadline();
                  if (choice === 'install') options.onProgress(`Downloading ${tool.label} indexer…`);
                  child.send(choice);
                }
              })
              .catch(fail);
          } else if (message.type === 'install-progress') {
            options.onProgress(plainText(String(message.message)));
          } else if (message.type === 'install-complete') {
            options.onProgress(undefined);
          } else if (message.type === 'result') {
            if (message.error) {
              log(String(message.error));
              // Build output may include source text. Keep it in the trusted desktop log.
              failure = new Error(`${tool.label} compiler preparation failed. See the analysis log for details.`);
            } else if (message.basic && request.fallback) result = { basic: true };
            else if (message.path === artifactPath) result = { path: artifactPath };
            else failure = new Error('Invalid compiler response.');
          }
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
          return;
        }
      }
    });
    child.stdout?.on('data', (chunk) => log(chunk.toString()));
    child.stderr?.on('data', (chunk) => log(chunk.toString()));
    child.on('error', fail);
    child.on('close', () => {
      clearTimeout(deadline);
      clearTimeout(killTimer);
      options.onProgress(undefined);
      options.signal.removeEventListener('abort', abort);
      if (options.signal.aborted) reject(new DOMException('Analysis cancelled', 'AbortError'));
      else if (failure) reject(failure);
      else if (result) resolve(result);
      else reject(new Error('Compiler process exited without an index.'));
    });
    child.stdin?.on('error', fail);
    child.stdin?.end(JSON.stringify({ repoRoot: options.repoRoot, artifactPath, request }));
  });
}
