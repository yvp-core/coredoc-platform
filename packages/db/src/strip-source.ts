/**
 * Source-code stripping helpers used at the client push boundary.
 *
 * `BaseNode.sourceCode` is captured during parsing because the summarization
 * stage needs it as AI prompt context, but it must never leave the client
 * filesystem after summarization. `stripSourceCode` is called immediately
 * before any push serialization; `containsSourceCode` is the companion check
 * used by server-side rejection (see apps/server/.../no-source-code.*).
 *
 * Both helpers perform a generic recursive walk — they match on the literal
 * key name `sourceCode` regardless of node type, so any future BaseNode-derived
 * type is covered automatically.
 */
import type { ParsedRepo, EmbeddingsOutput } from '@coredoc/core/types';

const SOURCE_KEY = 'sourceCode';
const INPUT_TEXT_KEY = 'inputText';

export interface StripResult {
  /** Deep-cloned ParsedRepo with every `sourceCode` key removed. */
  parsed: ParsedRepo;
  /** Number of `sourceCode` keys that were removed during the walk. */
  strippedCount: number;
}

/**
 * Remove every `sourceCode` field from a parsed repository.
 * Does not mutate the input — the original object is safe to reuse.
 */
export function stripSourceCode(parsed: ParsedRepo): StripResult {
  const clone = structuredClone(parsed);
  const strippedCount = stripInPlace(clone as unknown);
  // The repo root is the author's absolute local filesystem path (e.g.
  // /Users/alice/...). It's not read from the uploaded artifact (only used
  // locally by docs-graph) and is meaningless — and mildly leaky — off the
  // author's machine, so drop it from the copy that leaves the client. Only the
  // top-level repo path; per-file/package `path` fields are repo-relative.
  delete (clone as { path?: string }).path;
  return { parsed: clone, strippedCount };
}

/**
 * Check whether a value contains a `sourceCode` field anywhere in its
 * structure. Short-circuits on the first hit. Returns true even if the
 * key's value is empty — "key present" is the violation, not value content.
 */
export function containsSourceCode(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (containsSourceCode(item)) return true;
    }
    return false;
  }
  const obj = value as Record<string, unknown>;
  if (SOURCE_KEY in obj) return true;
  for (const key of Object.keys(obj)) {
    if (containsSourceCode(obj[key])) return true;
  }
  return false;
}

export interface StripEmbeddingsResult {
  /** Deep-cloned EmbeddingsOutput with every `inputText` field removed. */
  embeddings: EmbeddingsOutput;
  /** Number of `inputText` fields removed (functions + endpoints). */
  strippedCount: number;
}

/**
 * Remove the `inputText` field from every function and endpoint embedding.
 *
 * `inputText` is the literal text that was embedded; with `-i source|both` that
 * is raw source code. The server's graph only consumes the vector, the
 * `inputChecksum`, and the run-level `inputStrategy` (see transformer
 * mergeEmbeddings) — never `inputText` — so dropping it before a remote push is
 * lossless for the graph while keeping source on the client. Called at the push
 * boundary exactly like stripSourceCode; `containsSourceCode` cannot catch this
 * because the source rides in a value, not under a `sourceCode` key.
 *
 * Does not mutate the input — the original object is safe to reuse.
 */
export function stripEmbeddingInputText(embeddings: EmbeddingsOutput): StripEmbeddingsResult {
  const clone = structuredClone(embeddings);
  let strippedCount = 0;
  for (const list of [clone.functions, clone.endpoints]) {
    if (!list) continue;
    for (const emb of list) {
      if (INPUT_TEXT_KEY in emb) {
        delete (emb as { inputText?: string }).inputText;
        strippedCount += 1;
      }
    }
  }
  return { embeddings: clone, strippedCount };
}

/**
 * Check whether any embedding still carries a non-empty `inputText`. Companion
 * to the server-side rejection: a fail-closed server refuses embeddings that
 * still hold their input text. An absent or empty `inputText` (already stripped)
 * is not a violation.
 */
export function embeddingsContainInputText(embeddings: EmbeddingsOutput): boolean {
  for (const list of [embeddings.functions, embeddings.endpoints]) {
    if (!list) continue;
    for (const emb of list) {
      const text = (emb as { inputText?: unknown }).inputText;
      if (typeof text === 'string' && text.length > 0) return true;
    }
  }
  return false;
}

function stripInPlace(value: unknown): number {
  if (value === null || typeof value !== 'object') return 0;

  if (Array.isArray(value)) {
    let count = 0;
    for (const item of value) count += stripInPlace(item);
    return count;
  }

  const obj = value as Record<string, unknown>;
  let count = 0;
  if (SOURCE_KEY in obj) {
    delete obj[SOURCE_KEY];
    count += 1;
  }
  for (const key of Object.keys(obj)) {
    count += stripInPlace(obj[key]);
  }
  return count;
}
