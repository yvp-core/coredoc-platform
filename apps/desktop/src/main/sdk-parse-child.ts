import { withOptionalIndexHost, type OptionalIndexRequest } from '@coredoc/profile-parser/optional-index';
/**
 * Process bootstrap for generated-profile parsing.
 *
 * The parent launches this entry through macOS sandbox-exec. stdin carries one WorkerMessage,
 * stdout/stderr remain ordinary terminal logs, and descriptor 3 is reserved for the single
 * machine-readable result frame so parser output cannot corrupt the control protocol.
 */

import { withCSharpIndexHost, type CSharpIndexRequest, type CSharpIndexResponse } from '@coredoc/profile-parser/csharp';
import { createWriteStream } from 'node:fs';
import { handleCommandMessage, type WorkerMessage } from './sdk-worker-core.js';
import { scoreProfile } from '@coredoc/profile-parser';
import type { ProfileScoreMessage } from './profile-parse-sandbox.js';

const protocol = createWriteStream('', { fd: 3, autoClose: false });
let input = '';

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  input += chunk;
});
process.stdin.on('end', () => {
  void run();
});

function post(message: unknown): void {
  protocol.write(`${JSON.stringify(message)}\n`);
}

let requestId = 0;
function prepareIndex(
  request: CSharpIndexRequest | OptionalIndexRequest,
  kind: 'csharp-index' | 'optional-index' = 'csharp-index',
): Promise<CSharpIndexResponse> {
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    const receive = (raw: unknown) => {
      const message = raw as {
        type?: string;
        id?: number;
        result: CSharpIndexResponse;
        error?: string;
        cancelled?: boolean;
      };
      if (message?.type !== `${kind}-result` || message.id !== id) return;
      process.off('message', receive);
      if (message.error)
        reject(message.cancelled ? new DOMException(message.error, 'AbortError') : new Error(message.error));
      else resolve(message.result);
    };
    process.on('message', receive);
    process.send!({ type: kind, id, request }, (error) => {
      if (error) {
        process.off('message', receive);
        reject(error);
      }
    });
  });
}

async function run(): Promise<void> {
  try {
    const message = JSON.parse(input) as WorkerMessage | ProfileScoreMessage;
    if (message.command === 'score-profile' && 'profilePath' in message) {
      // The agent cannot execute builds. The existing host bridge owns compiler
      // consent and preparation, including when the first draft is being scored.
      const success = await withOptionalIndexHost(
        (request) => prepareIndex(request, 'optional-index'),
        () => withCSharpIndexHost(prepareIndex, () => scoreProfile(message.profilePath, message.repoRoot)),
      );
      post({ type: 'result', success });
      return;
    }
    if (message.command !== 'parse') {
      throw new Error(`Sandboxed parse child refuses command "${message.command}".`);
    }
    await withOptionalIndexHost(
      (request) => prepareIndex(request, 'optional-index'),
      () => withCSharpIndexHost(prepareIndex, () => handleCommandMessage(message, post)),
    );
  } catch (error) {
    post({
      type: 'result',
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    protocol.end();
    process.disconnect?.();
  }
}
