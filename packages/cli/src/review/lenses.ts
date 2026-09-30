import { z } from 'zod';

/**
 * Review lenses: one focused defect class per discovery agent, so a call carries one checklist
 * instead of "find anything". A cheap router picks the lenses a change needs; `logic` always runs.
 *
 * The policy texts are condensed from gstack's pre-landing review checklist
 * (`~/.claude/skills/gstack/review/checklist.md`, Pass 1 CRITICAL and Pass 2 INFORMATIONAL).
 * The Fix-First heuristic, severity presentation and the interactive AUTO-FIX/ASK parts are
 * dropped: this engine only proposes candidates, it never edits or asks.
 */
export enum LensId {
  /** Contracts, values and error paths. Always on. */
  Logic = 'logic',
  DataSafety = 'data-safety',
  Concurrency = 'concurrency',
  TrustBoundary = 'trust-boundary',
  Ui = 'ui',
}

const LOGIC = `Look only for broken contracts, incomplete value handling and defective error paths.

- A new enum value, status string, tier, kind or type constant: trace it through every consumer.
  Read the code that switches on, filters by, persists, serializes or displays the value. A consumer
  that falls through to a wrong default, an allowlist that does not include the new value, or a layer
  that accepts it but never stores it, is a defect.
- A removed or renamed value, field, column or route with a reader still expecting the old name,
  including persisted rows, cached payloads and clients that are not in this diff.
- Signature and shape changes: a parameter added without a default, an argument order change, a
  return type that gained or lost a field, a nullable that became required or vice versa, an option
  object whose new key is never read.
- API and schema contracts: request/response schema, status codes, pagination, error payloads and
  validation that diverge between the producer and a consumer in this repository.
- Defaults and configuration: a default that changed meaning for existing callers, a flag whose two
  states are not both handled, a limit or version constant duplicated in a second place that still
  holds the old value.
- Incorrect state transitions: a status set from the wrong precondition, a transition skipped, or a
  lifecycle field written without the accompanying one a reader requires.
- A catch that swallows the failure, returns a default the caller cannot distinguish from real data,
  is too broad and hides another failure class, or discards the original cause.
- An error thrown where the caller has no handler, or converted into a value nobody checks.
- Partial failure with no compensation: a multi-step write, publish or migration that can fail after
  the first step and leaves inconsistent state, with no transaction, idempotency key or cleanup.
- Cleanup that does not run on every path: a missing finally, a resource, lock, temp file, child
  process or connection leaked on the error path, or cleanup that runs twice.
- Failure recorded as success in metrics, status fields or job state, and error reporting that leaks
  internals to a user-facing surface.

Name the consumer and the input that reaches it, or the failure that triggers the path and its
observable consequence. Reading the consumer is required: a grep hit is not proof that the value is
handled, and a plausible name is not proof that it is not. Do not report "add a test" or "log more".`;

const DATA_SAFETY = `Look only for defects in the SQL and data-safety class.

- SQL assembled by string interpolation or concatenation, even from values that look coerced
  (to_i, Number(), parseInt): use parameterized queries, prepared statements or a query builder.
- Check-then-set that should be a single atomic conditional UPDATE (TOCTOU on a row).
- Writes that bypass model validation, hooks or constraints: update_column, QuerySet.update(),
  raw/unsafe ORM escapes, direct SQL where the model owns invariants.
- N+1 queries: an association loaded inside a loop, view or serializer without eager loading
  (includes/joinedload/include/select_related).
- Column, field or JSON key names in query calls (select, where, eq, gte, order, get, orderBy)
  that do not exist in the schema, or a result read under a name that was never selected. These
  silently return nothing or raise where no one looks; check the names against the schema in this
  repository, not against their plausibility.
- Migrations that are not reversible, that rewrite existing rows without a backfill guard, or whose
  column type/nullability disagrees with the code that writes the column.
- Type coercion across a serialization boundary: a value that switches between number and string as
  it crosses JSON, so digests, cache keys or equality comparisons diverge ({ cores: 8 } vs
  { cores: "8" }). Hash and digest inputs must normalize types before serialization.
- Date-key or time-window lookups that assume a key covers a full day, or two related features that
  bucket the same data differently (hourly vs daily).

Trace each claim to the schema and to a concrete caller. Do not report style, naming or "consider an
index" advice, and do not report a query pattern you have not seen in the pinned source.`;

const CONCURRENCY = `Look only for defects in the concurrency and ordering class.

- Read-check-write without a uniqueness constraint, or without catching the duplicate-key error and
  retrying: concurrent callers both pass the check.
- find-or-create, upsert-by-select or "insert if absent" without a unique index on the same key.
- Status or state transitions that are not atomic (no conditional UPDATE on the old value), so
  concurrent updates skip a transition or apply it twice.
- Work that assumes it is the only writer: counters, aggregates, balances or queue claims updated
  with read-modify-write instead of an atomic operation.
- Retry and cancellation mistakes: a retry around a non-idempotent side effect, a retry that
  re-executes a partially committed transaction, an AbortSignal or timeout that is created but never
  passed down, or cleanup that runs after cancellation and undoes committed work.
- Unawaited promises, floating async work after a response is sent, Promise.all over operations that
  must be ordered, or a shared mutable structure written from concurrent tasks.
- Locks, leases or semaphores acquired without a release on every path, released twice, or held
  across an await that can block indefinitely.
- Timers and scheduled work that assume an interval completed before the next one starts.

A defect here needs a concrete interleaving: name the two executions and the order that breaks the
invariant. Do not report theoretical races where a constraint, transaction or single-writer guarantee
already serializes the work.`;

const TRUST_BOUNDARY = `Look only for defects at a trust boundary.

- Model or LLM output used as if it were validated: generated emails, URLs, ids, names or numbers
  persisted, mailed, redirected to or used in a query without a format check.
- Structured tool output (arrays, objects) consumed without a shape or type check before it reaches
  storage, another service or a template.
- Generated or user-supplied URLs fetched without an allowlist (SSRF to internal addresses), and
  generated text stored into a knowledge base or vector index without sanitization (stored prompt
  injection).
- Shell and code execution: exec/spawn/system/subprocess with a shell and an interpolated command
  string instead of an argument array; eval or dynamic code on untrusted or generated input.
- Path handling that accepts traversal (.., absolute paths, symlinks) or reaches outside the intended
  root, and file writes to a location an untrusted input names.
- Authentication and authorization: a route, handler, tool or job that lost its guard, checks
  authentication but not ownership, trusts a client-supplied id, tenant or role, or widens a scope,
  permission or token audience.
- Secrets and data exposure: credentials, tokens or private source in logs, errors, telemetry,
  responses or prompts; a redaction that the new code path bypasses.
- Unescaped rendering of untrusted data (html_safe, raw, dangerouslySetInnerHTML, v-html, |safe).

Report only a reachable path from an untrusted input to the unsafe use, naming both ends. Read the
guards that already exist before claiming one is missing.`;

const UI = `Look only for defects a user of this interface would observe.

- State that renders wrongly: a loading, empty, error or partial state with no branch, so the surface
  shows a spinner forever, an empty list where data failed, or stale data after a mutation.
- A data dependency that is not invalidated or refetched after the write that changes it, or a query
  key / cache key built from an unstable value on every render.
- Effects and subscriptions that are not cleaned up, or that re-run every render because a dependency
  is recreated.
- Keyboard and screen-reader basics on a control the change adds: no accessible name, a click handler
  on a non-interactive element, focus lost or trapped after an open/close.
- A value displayed in the wrong unit, scale, timezone or locale, or a number formatted so a real
  value becomes unreadable.

Name the interaction that shows the defect. Do not report spacing, colour, wording or component
choice: taste is out of scope.`;

/** Declaration order is the catalogue order: lens selection and candidate merge both follow it. */
export const LENSES: Record<LensId, { text: string; summary: string }> = {
  [LensId.Logic]: {
    text: LOGIC,
    summary: 'contracts, enum/value completeness, consumers of new values, error paths, state transitions',
  },
  [LensId.DataSafety]: { text: DATA_SAFETY, summary: 'SQL, schema/query names, migrations, data integrity' },
  [LensId.Concurrency]: { text: CONCURRENCY, summary: 'races, atomicity, retries, cancellation, ordering' },
  [LensId.TrustBoundary]: {
    text: TRUST_BOUNDARY,
    summary: 'untrusted or model-generated input, shell, paths, auth/permissions, secret exposure',
  },
  [LensId.Ui]: { text: UI, summary: 'rendering states, data invalidation, accessibility basics, formatting' },
};

export const LENS_ORDER = Object.keys(LENSES) as LensId[];

/** The catalogue as the router sees it: ids it may choose and what each one covers. */
export const LENS_CATALOGUE = LENS_ORDER.map((id) => `${id}: ${LENSES[id].summary}`);

// `id` is a free string, not an enum: an unknown id is dropped by normalizeRoute() instead of
// invalidating the whole router answer, and a strict provider schema rejects optional properties.
export const routerSchema = z
  .object({
    lenses: z
      .array(
        z
          .object({
            id: z.string().max(40),
            reason: z.string().max(200),
            focusFiles: z.array(z.string().max(1000)).max(25),
          })
          .strict(),
      )
      .max(12),
  })
  .strict();

export interface Route {
  id: LensId;
  reason: string;
  focusFiles: string[];
}

/**
 * The router's choice as the host will run it: unknown and duplicate ids dropped, `logic` always
 * present, catalogue order, at most `maxLenses` entries, and focus files restricted to the eligible
 * changed paths this run actually sent.
 */
export function normalizeRoute(
  chosen: z.infer<typeof routerSchema>['lenses'],
  eligiblePaths: string[],
  maxLenses: number,
): Route[] {
  const eligible = new Set(eligiblePaths);
  const routes = new Map<LensId, Route>();
  for (const entry of chosen) {
    const id = LENS_ORDER.find((known) => known === entry.id);
    if (!id || routes.has(id)) continue;
    routes.set(id, {
      id,
      reason: entry.reason,
      focusFiles: entry.focusFiles.filter((path) => eligible.has(path)).slice(0, 25),
    });
  }
  // `logic` is the floor of every review, so the router cannot route a change past it.
  if (!routes.has(LensId.Logic))
    routes.set(LensId.Logic, { id: LensId.Logic, reason: 'Always reviewed', focusFiles: [] });
  return LENS_ORDER.filter((id) => routes.has(id))
    .map((id) => routes.get(id)!)
    .slice(0, maxLenses);
}
