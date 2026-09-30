/**
 * Parsing of the server's structured error bodies.
 *
 * The cloud API answers a request that outlived its synchronous budget with a
 * JSON body carrying a machine-readable `code` (and, for job-backed routes, the
 * `jobId` that keeps running in the background). The CLI sees that body in two
 * shapes: raw response text (when it inspects a `Response` itself) and embedded
 * in an Error message (when a fetch wrapper already turned the response into a
 * throw). Both are handled here so callers never pattern-match free text —
 * matching on '504' or 'still running' would misfile genuine failures.
 */

/** Server code for "the job outlived the request budget and is still running". */
export const JOB_STILL_RUNNING_CODE = 'job_still_running';

export interface StructuredServerError {
  code: string;
  /** Present on job-backed routes; null when the body carries no job id. */
  jobId: string | null;
}

function bodyText(source: unknown): string {
  if (typeof source === 'string') return source;
  if (source instanceof Error) return source.message;
  return '';
}

function fromObject(source: unknown): StructuredServerError | null {
  if (!source || typeof source !== 'object') return null;
  const { code, jobId } = source as { code?: unknown; jobId?: unknown };
  if (typeof code !== 'string') return null;
  return { code, jobId: typeof jobId === 'string' ? jobId : null };
}

/**
 * Extract `{ code, jobId }` from a server error body, or null when the body is
 * not a structured error.
 *
 * @param source raw response body text, an Error whose message embeds it, or an
 *   already-parsed body object (a persisted job error, for instance).
 */
export function parseStructuredServerError(source: unknown): StructuredServerError | null {
  const direct = fromObject(source);
  if (direct) return direct;
  const text = bodyText(source);
  const jsonStart = text.indexOf('{');
  if (jsonStart < 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(jsonStart));
  } catch {
    return null;
  }
  return fromObject(parsed);
}
