import { AsyncLocalStorage } from 'node:async_hooks';

// The read repository interfaces take no per-call options, so the abort signal
// of an MCP tool call travels as async context to the drivers that run the
// queries instead of through every repository method.
const readSignal = new AsyncLocalStorage<AbortSignal>();

/**
 * The MCP tool deadline. Kept under the ingress's 60 s proxy read timeout, so the
 * agent gets an answer instead of a dropped transport. It lives here because
 * local read-only drivers also use it as their query timeout.
 */
export const TOOL_DEADLINE_MS = 45_000;

/** Run `fn` so every graph read it starts can observe `signal`. */
export function withReadSignal<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
  return readSignal.run(signal, fn);
}

/** The abort signal of the enclosing {@link withReadSignal}, if any. */
export function currentReadSignal(): AbortSignal | undefined {
  return readSignal.getStore();
}
