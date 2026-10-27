import { TOOL_DEADLINE_MS, withReadSignal } from '@coredoc/db';

export class ToolDeadlineError extends Error {
  readonly code = 'tool_deadline';

  constructor(toolName: string) {
    super(
      `${toolName} did not finish in ${TOOL_DEADLINE_MS / 1000} s; narrow the scope (repo, depth, path) and retry.`,
    );
    this.name = 'ToolDeadlineError';
  }

  /** The MCP content block both the local and the cloud server answer with. */
  toContent(): Array<{ type: 'text'; text: string }> {
    return [{ type: 'text', text: JSON.stringify({ status: 'error', code: this.code, message: this.message }) }];
  }
}

/**
 * Run one tool call under the tool deadline. Graph reads inside `run` see the
 * deadline's abort signal (see `withReadSignal`), so an expired call stops its
 * queries rather than only abandoning them. Rejects with {@link ToolDeadlineError}
 * on expiry.
 */
export function withToolDeadline<T>(toolName: string, run: () => Promise<T>): Promise<T> {
  // A timer rather than AbortSignal.timeout: the same expiry, but it is cleared
  // when the call finishes and test fake timers can drive it.
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    // Registered before any reader listens, so the deadline error settles the
    // call before a reader's own abort rejection can.
    controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
    const timer = setTimeout(() => controller.abort(new ToolDeadlineError(toolName)), TOOL_DEADLINE_MS);
    withReadSignal(controller.signal, run)
      .then(resolve, reject)
      .finally(() => clearTimeout(timer));
  });
}
