/**
 * The bounded-content contract (spec §10): what a string is allowed to contain
 * anywhere in an intent request.
 *
 * Lifted from the archived `intent-authority.contract.ts`
 * (`archive/intent-cloud-first-v1`) with the detection logic UNCHANGED — same
 * secret and email patterns, same depth and node budgets, same source-body
 * heuristic, same URL credential check. The one required change (audit §1) is
 * reporting: the archive threw a bare `Error` naming only the leaf key, so a
 * caller could not tell WHICH `statement` of WHICH item failed. The walk now
 * accumulates the full path and throws the §12 public triple.
 *
 * Why a walker at all, when the schemas already bound every declared field:
 * optional payloads and the import overlay legitimately carry free-form JSON
 * objects, and that is exactly where a transcript, an API key, or a reporter's
 * email address would otherwise ride into the workspace.
 */
import type { PipeTransform } from '@nestjs/common';
import type { z } from 'zod';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe.js';
import { IntentErrorCode, type IntentErrorDetail, intentContractViolation } from './intent-errors.js';

/**
 * Structure budgets. `maxDepth` and `maxStructureNodes` are the archive's
 * values; `maxMultilineChars` is its source-body threshold.
 */
export const INTENT_CONTENT_LIMITS = {
  maxDepth: 20,
  maxStructureNodes: 5_000,
  maxMultilineChars: 500,
  /**
   * Import walks a whole local overlay in one request, and that overlay is
   * itself bounded by `INTENT_LIMITS` in `@coredoc/core` (500 items × a bounded
   * payload, 2000 relations). Its node count is an order of magnitude above a
   * single mutation's, so import passes this budget explicitly rather than the
   * default one — a legitimate full-size overlay must not be refused as
   * oversized structure.
   */
  maxImportStructureNodes: 100_000,
} as const;

// Verbatim from the archive. Matches PEM private-key headers, `key: value`
// assignments of credential-named fields, and the common token prefixes.
const SECRET_PATTERN =
  /(?:-----BEGIN [A-Z ]+PRIVATE KEY-----|\b(?:api[_-]?key|password|secret|access[_-]?token)\s*[:=]|\b(?:ghp|github_pat|sk)-[A-Za-z0-9_-]{12,})/i;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;

// Query parameter names that carry a credential by convention.
const CREDENTIAL_QUERY_PARAM = /token|key|secret|password/i;

/**
 * C0 controls except `\n` (0x0A) and `\t` (0x09), plus DEL (0x7F) and every C1
 * control (0x80–0x9F).
 *
 * Intent content is AGENT-AUTHORED text that is stored and then RE-SERVED to
 * humans and to other agents as reviewed intent, so a string is a display
 * surface as much as a value. The excluded characters are the ones that make a
 * stored statement render as something other than what it says: `\r` splits a
 * line in a log or a CSV export, `\b`/`\x1b` drive a terminal (ANSI escapes,
 * cursor moves, colour), `\0` truncates in C-string consumers, and the C1 range
 * is a second, less-known escape introducer that `\x1b`-only filters miss.
 *
 * Newline and tab are the two that carry MEANING in a bounded statement — a
 * multi-line rule, an indented list — and they are already bounded by the
 * source-body heuristic below.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point — this is the filter that keeps them out of stored intent.
const DISALLOWED_CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/;

export interface AssertSafeCloudContentOptions {
  /** Node budget for this request (defaults to {@link INTENT_CONTENT_LIMITS.maxStructureNodes}). */
  maxStructureNodes?: number;
  /** Path prefix of the walked value, when it is not the request root. */
  path?: string[];
}

/**
 * Reject secret-shaped, PII-shaped, source-body-shaped, credentialed-URL, and
 * over-large content anywhere inside `value`.
 *
 * Throws {@link IntentPublicException} naming the full path of the first
 * offending field. First-failure-wins is deliberate: the walk stops at content
 * it must not keep looking at, and one exact path is more actionable than a
 * list built by continuing to traverse untrusted data.
 */
export function assertSafeCloudContent(value: unknown, options: AssertSafeCloudContentOptions = {}): void {
  walk(value, options.path ?? [], { nodes: 0 }, options.maxStructureNodes ?? INTENT_CONTENT_LIMITS.maxStructureNodes);
}

function walk(value: unknown, path: string[], budget: { nodes: number }, maxStructureNodes: number): void {
  budget.nodes += 1;
  if (path.length > INTENT_CONTENT_LIMITS.maxDepth) {
    throw intentContractViolation(
      IntentErrorCode.ContentStructureExceeded,
      `Intent content nests deeper than the ${INTENT_CONTENT_LIMITS.maxDepth}-level limit`,
      path,
    );
  }
  if (budget.nodes > maxStructureNodes) {
    throw intentContractViolation(
      IntentErrorCode.ContentStructureExceeded,
      `Intent content exceeds the bounded structure limit of ${maxStructureNodes} nodes`,
      path,
    );
  }

  if (typeof value === 'string') {
    assertSafeString(value, path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => walk(entry, [...path, String(index)], budget, maxStructureNodes));
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      walk(child, [...path, key], budget, maxStructureNodes);
    }
  }
}

function assertSafeString(value: string, path: string[]): void {
  // First, because it is the cheapest and the most structural: everything below
  // reasons about the string as text, and a control character means it is not.
  if (DISALLOWED_CONTROL_CHARS.test(value)) {
    throw intentContractViolation(
      IntentErrorCode.ContentControlChars,
      'Intent content must not contain control characters; only newline and tab are allowed',
      path,
    );
  }
  if (SECRET_PATTERN.test(value)) {
    throw intentContractViolation(
      IntentErrorCode.ContentSecretShaped,
      'Intent content must not contain secret-shaped text (keys, tokens, credential assignments)',
      path,
    );
  }
  if (EMAIL_PATTERN.test(value)) {
    // Identity comes from the auth token, never from payload text (spec §10).
    throw intentContractViolation(
      IntentErrorCode.ContentEmailShaped,
      'Intent content must not contain an email address; actor identity comes from the auth token',
      path,
    );
  }
  if (value.includes('\n') && value.length > INTENT_CONTENT_LIMITS.maxMultilineChars) {
    throw intentContractViolation(
      IntentErrorCode.ContentSourceBodyShaped,
      'Intent content looks like a pasted source body rather than a bounded statement',
      path,
    );
  }
  if (path[path.length - 1] === 'url') assertSafeUrl(value, path);
}

function assertSafeUrl(value: string, path: string[]): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    // The archive let this `new URL` throw a raw TypeError; declared `url`
    // fields are schema-validated first, but the free-form payload and the
    // import overlay can carry any `url` key, so the refusal is typed here
    // instead of surfacing as an unexpected 500.
    throw intentContractViolation(
      IntentErrorCode.ContentUrlUnparseable,
      'Intent content field named url must be a parseable absolute URL',
      path,
    );
  }
  if (url.username || url.password || [...url.searchParams.keys()].some((name) => CREDENTIAL_QUERY_PARAM.test(name))) {
    throw intentContractViolation(
      IntentErrorCode.ContentUrlCredentials,
      'Intent content URLs must not carry credentials or token-shaped query parameters',
      path,
    );
  }
}

export interface ParseContractOptions {
  maxStructureNodes?: number;
}

/**
 * The single validation entry point for every intent operation, on every
 * surface: REST controllers and MCP tools both call this with the SAME schema
 * instance, so the two surfaces cannot drift.
 *
 * Order matters — schema first, content walk second: the walk is only sound on
 * a value whose shape is already known, and a caller gets the more specific
 * shape error rather than a content error about a field that should not exist.
 */
export function parseContract<T>(schema: z.ZodType<T>, input: unknown, options: ParseContractOptions = {}): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw schemaViolation(parsed.error);
  assertSafeCloudContent(parsed.data, { maxStructureNodes: options.maxStructureNodes });
  return parsed.data;
}

/**
 * `@Body(intentContractPipe(Schema))` / `@Query(intentContractPipe(Schema))` — `parseContract`
 * moved to the controller boundary (`.scratch/server-structure-cleanup/spec.md`, Track B2).
 *
 * The same schema instance, the same schema-violation mapping and the same content walk run in
 * the same order, so a REST rejection body is exactly what it was when the handler called
 * `parseContract` itself. MCP tools keep calling `parseContract` directly: it stays the single
 * validation entry point for both surfaces.
 */
export function intentContractPipe<T>(
  schema: z.ZodType<T>,
  options: ParseContractOptions = {},
): PipeTransform<unknown, T> {
  // The walk rides as a refinement so the pipe stays the generic zod one: zod skips a refinement
  // whose schema already failed (shape error first, as `parseContract` orders them) and lets the
  // typed content refusal propagate out of `safeParse` untouched.
  const withContentWalk = schema.superRefine((value) => {
    assertSafeCloudContent(value, { maxStructureNodes: options.maxStructureNodes });
  });
  return new ZodValidationPipe(withContentWalk, schemaViolation);
}

function schemaViolation(error: z.ZodError): never {
  const details: IntentErrorDetail[] = error.issues.map((issue) => ({
    code: IntentErrorCode.SchemaViolation,
    // Zod messages state the rule ("Unrecognized key", "Too big: expected
    // string to have <=200 characters"); they do not echo the offending value.
    message: issue.message,
    path: issue.path.map(String),
  }));
  const first = details[0];
  throw intentContractViolation(
    IntentErrorCode.SchemaViolation,
    first?.message ?? 'The request does not match the intent operation schema',
    first?.path ?? [],
    details.length > 1 ? details : undefined,
  );
}
