/** Trusted compiler bootstrap. Never imports or executes an extraction profile. */
import { createWriteStream, existsSync } from 'node:fs';
import {
  checkCSharpPrerequisites,
  prepareCSharpIndex,
  installCSharpTool,
  installedCSharpTool,
} from '@coredoc/profile-parser/csharp-tools';
import { validateCSharpIndexRequest } from '@coredoc/profile-parser/csharp';

const protocol = createWriteStream('', { fd: 3, autoClose: false });
protocol.on('error', () => process.kill(process.pid, 'SIGTERM'));
const post = (value: unknown) => protocol.write(`${JSON.stringify(value)}\n`);
let input = '';
// A vanished desktop must not leave a compiler and restore process behind.
process.once('disconnect', () => {
  if (!process.connected) process.kill(process.pid, 'SIGTERM');
});
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', () => {
  void run();
});
async function run(): Promise<void> {
  try {
    const { repoRoot, artifactPath, request: inputRequest } = JSON.parse(input);
    const request = validateCSharpIndexRequest(inputRequest);
    let installError: string | undefined;
    for (;;) {
      const issue = installError ?? checkCSharpPrerequisites(repoRoot, request.defines);
      if (!issue) break;
      const choice = await new Promise<unknown>((resolve) => {
        process.once('message', resolve);
        post({
          type: 'prerequisites',
          message: issue,
          canInstall:
            !process.env.COREDOC_SCIP_DOTNET?.trim() &&
            !installedCSharpTool(repoRoot) &&
            (process.platform === 'darwin' || (process.platform === 'linux' && !existsSync('/etc/alpine-release'))),
        });
      });
      if (choice === 'basic' && request.fallback) {
        post({ type: 'result', basic: true });
        return;
      }
      if (choice === 'install') {
        const controller = new AbortController();
        const cancel = () => controller.abort();
        process.once('SIGTERM', cancel);
        try {
          await installCSharpTool(repoRoot, {
            signal: controller.signal,
            onLog: console.info,
            onProgress(received, total) {
              const amount = (received / 1_000_000).toFixed(1);
              const size = total ? ` of ${(total / 1_000_000).toFixed(1)} MB` : ' MB';
              post({ type: 'install-progress', message: `Downloading C# indexer: ${amount}${size}` });
            },
          });
          post({ type: 'install-complete' });
          installError = undefined;
        } catch (error) {
          if (controller.signal.aborted) throw error;
          installError = error instanceof Error ? error.message : String(error);
        } finally {
          process.removeListener('SIGTERM', cancel);
        }
        continue;
      }
      if (choice !== 'retry') throw new Error('Enhanced analysis cancelled.');
      installError = undefined;
    }
    console.info('[coredoc] Preparing enhanced C# analysis in an isolated source copy…');
    await prepareCSharpIndex(repoRoot, request.projects, undefined, request.defines, artifactPath);
    post({ type: 'result', path: artifactPath });
  } catch (error) {
    post({ type: 'result', error: error instanceof Error ? error.message : String(error) });
  } finally {
    protocol.end();
    process.removeAllListeners('disconnect');
    process.disconnect?.();
  }
}
