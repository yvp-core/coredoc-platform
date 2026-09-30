/**
 * SDK Worker — runs CLI SDK functions in a worker thread.
 *
 * Why a worker thread?
 * - P0 Cancellation: worker.terminate() hard-kills a running operation
 * - P0 Isolation: parser crashes don't take down the main process
 * - P0 Main thread: long operations don't freeze the UI
 *
 * Communication:
 *   parent → worker: { command, options, cwd, configPath }
 *   worker → parent: { type: 'log', level, text } | { type: 'result', success, data?, error? }
 *
 * This file is the BOOTSTRAP only — it reassigns the output channels and wires
 * `parentPort`. All command routing + the settle/flush logic lives in the
 * side-effect-free {@link ./sdk-worker-core.ts} so it stays unit-testable.
 */

import { parentPort } from 'worker_threads';
import { handleCommandMessage, type WorkerMessage } from './sdk-worker-core.js';

if (!parentPort) {
  throw new Error('sdk-worker must run as a worker thread');
}

// ---------------------------------------------------------------------------
// Intercept ALL output channels → forward to parent as messages
// ---------------------------------------------------------------------------

console.log = (...args: unknown[]) => {
  parentPort!.postMessage({ type: 'log', level: 'info', text: args.join(' ') + '\r\n' });
};
console.error = (...args: unknown[]) => {
  parentPort!.postMessage({ type: 'log', level: 'error', text: args.join(' ') + '\r\n' });
};
console.warn = (...args: unknown[]) => {
  parentPort!.postMessage({ type: 'log', level: 'warn', text: args.join(' ') + '\r\n' });
};
console.info = (...args: unknown[]) => {
  parentPort!.postMessage({ type: 'log', level: 'info', text: args.join(' ') + '\r\n' });
};
process.stdout.write = ((chunk: string | Uint8Array): boolean => {
  parentPort!.postMessage({ type: 'log', level: 'info', text: String(chunk) });
  return true;
}) as typeof process.stdout.write;
process.stderr.write = ((chunk: string | Uint8Array): boolean => {
  parentPort!.postMessage({ type: 'log', level: 'error', text: String(chunk) });
  return true;
}) as typeof process.stderr.write;

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

parentPort.on('message', (msg: WorkerMessage) => {
  void handleCommandMessage(msg, (message) => parentPort!.postMessage(message));
});
