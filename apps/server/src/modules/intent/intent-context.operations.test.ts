/**
 * The context read's REQUEST contract: what a query string is allowed to say,
 * and what it means once normalised.
 *
 * Two properties carry weight here beyond ordinary parsing. First, the reason
 * vocabulary must stay a SUPERSET of `@coredoc/core`'s, or an agent that learned
 * the local reasons would silently mis-read a cloud answer. Second, every
 * refusal must state the rule and name the valid values — an unknown `kind` that
 * came back as an empty list would read as "this workspace has no such intent".
 */
import { INTENT_CONTEXT_LIMITS, IntentKind, IntentMatchReason } from '@coredoc/core';
import { describe, expect, it } from 'vitest';
import { IntentErrorCode, IntentPublicException, parseContract } from './contract/index.js';
import {
  INTENT_CONTEXT_READ_LIMITS,
  IntentContextMatchReason,
  IntentContextMode,
  IntentContextQuerySchema,
  intentQueryTokens,
  normalizeIntentContextRequest,
} from './intent-context.operations.js';

function normalize(raw: Record<string, unknown>) {
  return normalizeIntentContextRequest(parseContract(IntentContextQuerySchema, raw));
}

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return (error as IntentPublicException).publicError.code;
  }
  throw new Error('expected a refusal');
}

describe('match-reason vocabulary', () => {
  it('is a superset of the local overlay read s reasons, value for value', () => {
    const cloud = new Set<string>(Object.values(IntentContextMatchReason));
    for (const reason of Object.values(IntentMatchReason)) expect(cloud.has(reason)).toBe(true);
  });

  it('adds only the reasons the cloud can compute and the overlay cannot', () => {
    const local = new Set<string>(Object.values(IntentMatchReason));
    expect(
      Object.values(IntentContextMatchReason)
        .filter((reason) => !local.has(reason))
        .sort(),
    ).toEqual([
      IntentContextMatchReason.Attached,
      IntentContextMatchReason.Inherited,
      IntentContextMatchReason.NodeDerived,
      IntentContextMatchReason.Source,
    ]);
  });
});

describe('selectors', () => {
  it('accepts a bounded multiline task without treating it as a stored statement', () => {
    const task = 'Update the hosted graph query to respect repository scope.\n'.repeat(12).trim();
    expect(task.length).toBeGreaterThan(500);
    expect(normalize({ task }).task).toBe(task.replace(/\n/g, ' '));
    expect(codeOf(() => normalize({ task: 'x'.repeat(2001) }))).toBe(IntentErrorCode.SchemaViolation);
    expect(codeOf(() => normalize({ task: `${task}\npassword: unsafe` }))).toBe(IntentErrorCode.ContentSecretShaped);
    expect(codeOf(() => normalize({ task: `${task}\u001b[31m` }))).toBe(IntentErrorCode.ContentControlChars);
  });

  it('validates task files and rejects ambiguous or over-budget selectors', () => {
    const file = { repoKey: 'github.com/acme/orders', path: 'src/refund.ts' };
    expect(normalize({ task: 'Handle refunds', files: JSON.stringify(file) })).toMatchObject({
      task: 'Handle refunds',
      files: [file],
    });
    for (const input of [
      { task: 'refund', query: 'refund' },
      { task: 'refund', mode: 'list' },
      { files: JSON.stringify(file) },
      { task: 'refund', files: '{broken' },
      { task: 'refund', files: JSON.stringify({ ...file, path: '../other.ts' }) },
      {
        task: 'refund',
        nodeIds: Array.from({ length: 50 }, (_, i) => `hash:file:${i}.ts`),
        files: JSON.stringify(file),
      },
    ])
      expect(codeOf(() => normalize(input))).toBe(IntentErrorCode.SchemaViolation);
  });

  it('accepts exact ids as a comma list, as repeated parameters, or both', () => {
    expect(normalize({ intentIds: 'br-a,br-b' }).intentIds).toEqual(['br-a', 'br-b']);
    expect(normalize({ intentIds: ['br-a', 'br-b'] }).intentIds).toEqual(['br-a', 'br-b']);
    expect(normalize({ intentIds: ['br-a,br-b', 'br-c'] }).intentIds).toEqual(['br-a', 'br-b', 'br-c']);
    expect(normalize({ intentIds: 'br-a,br-a' }).intentIds).toEqual(['br-a']);
  });

  it('never splits a node id on a comma — an id may contain one', () => {
    expect(normalize({ nodeIds: 'aaaa:method:src/a.ts:f(a,b)' }).nodeIds).toEqual(['aaaa:method:src/a.ts:f(a,b)']);
    expect(normalize({ nodeIds: ['aaaa:file:a.ts', 'aaaa:file:b.ts'] }).nodeIds).toEqual([
      'aaaa:file:a.ts',
      'aaaa:file:b.ts',
    ]);
  });

  it('keeps a present-but-empty selector distinguishable from an absent one', () => {
    expect(normalize({ nodeIds: '' }).nodeIds).toEqual([]);
    expect(normalize({ intentIds: '' }).intentIds).toEqual([]);
    expect(normalize({}).nodeIds).toBeUndefined();
    expect(normalize({}).intentIds).toBeUndefined();
  });

  it('treats a blank query as no text selector at all', () => {
    expect(normalize({ query: '   ' }).query).toBeUndefined();
    expect(normalize({ query: 'refund window' }).query).toBe('refund window');
  });

  it('refuses more selector values than the server will answer', () => {
    const ids = Array.from({ length: INTENT_CONTEXT_READ_LIMITS.intentIds + 1 }, (_, index) => `br-${index}`);
    expect(codeOf(() => normalize({ intentIds: ids.join(',') }))).toBe(IntentErrorCode.SchemaViolation);
    expect(codeOf(() => normalize({ nodeIds: ids }))).toBe(IntentErrorCode.SchemaViolation);
  });

  it('parses repeated sourceRefs without splitting on commas, and bounds them with a path', () => {
    expect(normalize({ sourceRefs: 'spec/a,b.md' }).sourceRefs).toEqual(['spec/a,b.md']);
    expect(normalize({ sourceRefs: ['jira:DAY-1', 'jira:DAY-1', ''] }).sourceRefs).toEqual(['jira:DAY-1']);
    expect(normalize({ sourceRefs: '' }).sourceRefs).toEqual([]);
    expect(normalize({}).sourceRefs).toBeUndefined();

    const refs = Array.from({ length: INTENT_CONTEXT_READ_LIMITS.sourceRefs + 1 }, (_, i) => `jira:DAY-${i}`);
    const pathOf = (raw: Record<string, unknown>) => {
      try {
        normalize(raw);
      } catch (error) {
        const publicError = (error as IntentPublicException).publicError;
        expect(publicError.code).toBe(IntentErrorCode.SchemaViolation);
        return publicError.path;
      }
      throw new Error('expected a refusal');
    };
    expect(pathOf({ sourceRefs: refs })).toEqual(['sourceRefs']);
    expect(pathOf({ sourceRefs: 'x'.repeat(501) })?.[0]).toBe('sourceRefs');
  });

  it('refuses an unknown query parameter rather than ignoring it', () => {
    expect(codeOf(() => normalize({ nodeId: 'aaaa:file:a.ts' }))).toBe(IntentErrorCode.SchemaViolation);
  });

  it('bounds the token count of a lexical query', () => {
    expect(intentQueryTokens('refund window rule')).toEqual(['refund', 'window', 'rule']);
    expect(intentQueryTokens(undefined)).toEqual([]);
    const tooMany = Array.from({ length: INTENT_CONTEXT_READ_LIMITS.queryTokens + 1 }, (_, i) => `t${i}`).join(' ');
    expect(codeOf(() => intentQueryTokens(tooMany))).toBe(IntentErrorCode.SchemaViolation);
  });
});

describe('kind filter', () => {
  it('accepts the six declared kinds', () => {
    expect(normalize({ kind: IntentKind.BusinessRule }).kinds).toEqual([IntentKind.BusinessRule]);
  });

  it('accepts several kinds, repeated or comma-separated, de-duplicated', () => {
    expect(normalize({ kind: ['use_case', 'capability,use_case'] }).kinds).toEqual([
      IntentKind.UseCase,
      IntentKind.Capability,
    ]);
  });

  it('refuses an unknown kind, naming the valid values — not an empty answer', () => {
    let message = '';
    try {
      normalize({ kind: ['business_rule', 'rules'] });
    } catch (error) {
      const failure = error as IntentPublicException;
      expect(failure.publicError.code).toBe(IntentErrorCode.UnknownKind);
      message = failure.publicError.message;
    }
    for (const kind of Object.values(IntentKind)) expect(message).toContain(kind);
  });
});

describe('modes, bounds and pagination', () => {
  it('defaults to the context mode and core s item bound', () => {
    const request = normalize({});
    expect(request.mode).toBe(IntentContextMode.Context);
    expect(request.limit).toBe(INTENT_CONTEXT_LIMITS.default);
    expect(request.includeCandidates).toBe(false);
  });

  it('refuses a context limit above core s maximum rather than silently clamping it', () => {
    expect(normalize({ limit: String(INTENT_CONTEXT_LIMITS.max) }).limit).toBe(INTENT_CONTEXT_LIMITS.max);
    expect(codeOf(() => normalize({ limit: String(INTENT_CONTEXT_LIMITS.max + 1) }))).toBe(
      IntentErrorCode.InvalidPageLimit,
    );
    expect(codeOf(() => normalize({ limit: 'many' }))).toBe(IntentErrorCode.InvalidPageLimit);
  });

  it('stretches an omitted context limit to cover the exact ids that were named', () => {
    const ids = Array.from({ length: 6 }, (_, index) => `br-${index}`).join(',');
    // Six named ids are six answerable questions, not a page: truncating them
    // forced a second call for ids the caller already held.
    expect(normalize({ intentIds: ids }).limit).toBe(6);
    // Only the exact selector stretches, and an explicit limit still wins.
    expect(normalize({ query: 'refund window' }).limit).toBe(INTENT_CONTEXT_LIMITS.default);
    expect(normalize({ intentIds: ids, limit: '2' }).limit).toBe(2);
    // Never past the bound this read cannot be talked out of.
    const many = Array.from({ length: INTENT_CONTEXT_LIMITS.max + 5 }, (_, index) => `br-x${index}`).join(',');
    expect(normalize({ intentIds: many }).limit).toBe(INTENT_CONTEXT_LIMITS.max);
  });

  it('gives the list mode the larger page bound', () => {
    expect(normalize({ mode: IntentContextMode.List, limit: '150' }).limit).toBe(150);
  });

  it('refuses a cursor in context mode: a bounded read does not page', () => {
    expect(codeOf(() => normalize({ cursor: 'abc' }))).toBe(IntentErrorCode.CursorNotSupported);
  });

  it('accepts includeDiagnostics in context mode too: both modes are compact by default', () => {
    expect(normalize({ includeDiagnostics: 'true' }).includeDiagnostics).toBe(true);
    expect(normalize({ includeDiagnostics: 'false' }).includeDiagnostics).toBe(false);
  });

  it('refuses more exact ids than one list page holds, naming the limit', () => {
    const ids = Array.from({ length: 4 }, (_, index) => `br-${index}`).join(',');
    // Exact ids ride the first page only, and the cursor pages a different
    // order — a truncated first page with `nextCursor: null` is a dead end.
    const refusal = () => normalize({ mode: IntentContextMode.List, limit: '3', intentIds: ids });
    expect(codeOf(refusal)).toBe(IntentErrorCode.SchemaViolation);
    try {
      refusal();
    } catch (error) {
      const publicError = (error as IntentPublicException).publicError;
      expect(publicError.message).toContain('at most 3');
      expect(publicError.path).toEqual(['intentIds']);
    }
  });

  it('accepts exact ids that fit the page, and leaves the context mode s bounded answer alone', () => {
    expect(normalize({ mode: IntentContextMode.List, limit: '3', intentIds: 'br-a,br-b,br-c' }).intentIds).toHaveLength(
      3,
    );
    // Context mode does not page at all: it reports omittedCount instead.
    expect(normalize({ limit: '1', intentIds: 'br-a,br-b' }).intentIds).toHaveLength(2);
  });

  it('opts into candidates only on an explicit true', () => {
    expect(normalize({ includeCandidates: 'true' }).includeCandidates).toBe(true);
    expect(normalize({ includeCandidates: 'false' }).includeCandidates).toBe(false);
    const list = IntentContextMode.List;
    expect(normalize({ mode: list, includeDiagnostics: 'true' }).includeDiagnostics).toBe(true);
    expect(normalize({ mode: list, includeDiagnostics: 'false' }).includeDiagnostics).toBe(false);
  });

  it('bounds the context parameter in bytes on the MCP path too, which skips the query schema', () => {
    const refusal = (context: string) => {
      try {
        normalizeIntentContextRequest({ context });
      } catch (error) {
        return (error as IntentPublicException).publicError;
      }
      throw new Error('expected a refusal');
    };
    const oversized = JSON.stringify({ country: 'x'.repeat(INTENT_CONTEXT_READ_LIMITS.context) });
    expect(refusal(oversized)).toMatchObject({ code: IntentErrorCode.SchemaViolation, path: ['context'] });
    expect(refusal('["de"]')).toMatchObject({ code: IntentErrorCode.SchemaViolation, path: ['context'] });
    expect(normalizeIntentContextRequest({ context: '{"country":"de"}' }).context).toEqual({ country: 'de' });
  });
});

describe('observed checkout state', () => {
  const commit = 'a'.repeat(40);

  it('reads one repository per parameter, with an optional dirty marker', () => {
    const request = normalize({
      observed: [`github.com/acme/orders-api@${commit}`, `github.com/acme/reports-web@${commit}:dirty`],
    });
    expect(request.observed).toEqual({
      'github.com/acme/orders-api': { commit, dirty: false },
      'github.com/acme/reports-web': { commit, dirty: true },
    });
  });

  it('splits at the LAST separator, so a repo key containing one still resolves', () => {
    expect(normalize({ observed: `github.com/acme/x@v2@${commit}` }).observed).toEqual({
      'github.com/acme/x@v2': { commit, dirty: false },
    });
  });

  it('reports nothing observed when the caller said nothing — never a fabricated current', () => {
    expect(normalize({}).observed).toEqual({});
  });

  it('refuses a malformed observed value rather than dropping it', () => {
    expect(codeOf(() => normalize({ observed: 'github.com/acme/x' }))).toBe(IntentErrorCode.SchemaViolation);
    expect(codeOf(() => normalize({ observed: 'github.com/acme/x@not-a-commit' }))).toBe(
      IntentErrorCode.SchemaViolation,
    );
    expect(codeOf(() => normalize({ observed: `@${commit}` }))).toBe(IntentErrorCode.SchemaViolation);
  });
});
