/**
 * Debug Logger for MCP Tools
 *
 * Uses stderr to avoid corrupting the JSON-RPC stream on stdout.
 * Enable with MCP_DEBUG=1 environment variable.
 */

const DEBUG_ENABLED = process.env.MCP_DEBUG === '1' || process.env.MCP_DEBUG === 'true';

/**
 * Log debug message to stderr (safe for MCP)
 */
export function debug(label: string, ...args: unknown[]): void {
  if (!DEBUG_ENABLED) return;

  const timestamp = new Date().toISOString().slice(11, 23);
  const prefix = `[${timestamp}] [MCP:${label}]`;

  // Format args for better readability
  const formatted = args.map((arg) => {
    if (typeof arg === 'string') return arg;
    try {
      return JSON.stringify(arg, null, 2);
    } catch {
      return String(arg);
    }
  });

  console.error(prefix, ...formatted);
}

/**
 * Log query results summary
 */
export function debugResult(label: string, recordCount: number, sample?: unknown): void {
  if (!DEBUG_ENABLED) return;

  debug(label, `Result: ${recordCount} records`);
  if (sample) {
    console.error('Sample:', JSON.stringify(sample, null, 2));
  }
}
