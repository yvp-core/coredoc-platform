---
size: m
status: draft
---

# SF-006 — Intent tool fixes from agent session feedback

Last reviewed: 2026-10-26

Source: one week of agent session feedback from the day.io workspace (2026-10-19 to 2026-10-26, 19 records, 8 users), reviewed with the owner on 2026-10-26. Decisions taken by the owner:

- `get_intent_context` matches free text with every word, never with any word; `intent_read search` keeps its labelled any-word fallback;
- the answer names the `sourceRefs` that matched nothing;
- the tree shows accepted and candidate counts instead of a bare `(empty)`; no hide-empty option;
- `intent_read search` without candidates says how many candidates also match;
- a propose batch stays atomic, but its refusal lists every title that is too long and states the id limit;
- the tool descriptions state what the tree marker counts, the search `includeCandidates` option and the id limit.

## Verified current state

- **Context text paths.** `IntentContextService.readContext` (`apps/server/src/modules/intent/intent-context.service.ts`, around :1115) has two text paths.
  - `query` without `task` → `selectLexical(where, tokens, scan + 1, true)` → `matchLexically` (`intent-lexical.ts`). It tries every word first. If nothing matches and the query has 2+ words, it retries with any word and sets `fallback`.
  - `task` → `selectTaskText` (:729), a full-text OR query (`to_tsquery(w1 | w2 | …)`) gated by `relevant`. `relevant` passes when the title matches **any** task word, or when the statement shares at least two task lexemes.
  - Both reach unrelated items when the workspace holds few accepted items. In two sessions, a task about hours-to-days conversion with an unmatched Jira key returned audit-log and MCP-server items.
- **sourceRefs.** `selectBySource` (:616) matches `intent_item_sources.ref`. A `jira:` ref compares case-insensitively against `kind='issue'` sources only (`sourceRefMatchSets`, `intent-context.select.ts:270`). `hasSelector` (:246) counts `sourceRefs`, so an unmatched ref with no other selector returns `matches: []`. The answer has `unknownIntentIds`, but nothing that names unmatched refs.
- **Tree.** `IntentReadService.tree` (`intent-read.service.ts:182`) counts items with `authority: accepted` only (:196) and prints ` (empty)` when a node's own count is 0 (:220). Sub-feature items are not rolled up. A domain is `(empty)` only when it and all its features are. The tool description (`apps/server/src/mcp/tools/intent.tools.ts:468`) says "(empty) marks a node with no items". In the day.io workspace every payroll node reads `(empty)` while it holds about 65 candidates.
- **Search.** `IntentReadService.search` (:317) filters by `authorities(request.includeCandidates)` (:342). The all/any decision is made once and labelled `matched: 'any'`. The tool description's search signature omits `includeCandidates`, but the schema accepts it (:414, :436).
- **Propose ids.** `deriveIntentId` (`packages/core/src/intent/derive-id.ts`) builds `<kind-prefix>-<slug>`. When the slug does not fit `INTENT_ID_MAX_LENGTH = 64` (`packages/core/src/intent/types.ts:56`, prefix included), it throws `IdWouldTruncate`.
  - `deriveIntentItemId` (`intent-id.ts:40`) maps that to `{code:'id_would_truncate', message, path:['items',i,'title']}`. It is called from `planProposal` (`intent-propose.plan.ts:165`) item by item inside one transaction, so the first bad title refuses the batch and later bad titles stay unknown.
  - The tool description (`intent.tools.ts:483-500`) names the refusal but not the 64-character limit, and `title` has no field description.
  - Batches hold at most 10 items (`INTENT_CONTRACT_LIMITS.batch`, `contract/intent-primitives.ts:80`). In one session, two of four batches were refused one title at a time.

## Scope

**In:**
1. `get_intent_context` text matching without the any-word path.
2. `unmatchedSourceRefs` in the context answer.
3. Tree counts.
4. Search candidate hint.
5. All too-long titles in one refusal.
6. Tool description fixes.

**Non-goals:**
- more than 10 items per batch;
- a combined propose-and-accept call;
- a require-all-words option for `intent_read search`;
- rolling sub-feature counts up into the parent;
- the 503s seen on `intent_review` (an infrastructure question, tracked separately).

## Contracts

- **Context `query` path.** `selectLexical` is called with `allowFallback: false` from `readContext`, so a query with no all-words match discovers nothing. `intent_read search` keeps its fallback unchanged.
- **Context `task` path.** `relevant` drops the title-matches-any-word escape. An item is relevant when the task lexemes it shares with title ∪ statement number at least `GREATEST(1, LEAST(2, cardinality(task lexemes)))`.
  - Exact ids, code-linked constraints and node-anchored items still bypass the predicate, as today.
  - See D-1 (resolved).
- **`unmatchedSourceRefs`.** Each requested ref that selected no item (after the same normalization `sourceRefMatchSets` applies) is returned in the structured answer as `unmatchedSourceRefs: string[]`, omitted when empty.
  - The text answer adds one line: `No item cites <refs>.`
  - When text discovery still returned items, that line continues: `; the items below matched the task text only.`
- **Tree.** Each node prints `(<a> accepted · <c> candidates)` for its own items, or `(empty)` when both are 0. The header becomes `N accepted items, M candidates`. Candidate counts use the same `groupBy` with `authority: candidate`. Archived and rejected items are not counted.
- **Search hint.** When `includeCandidates` is not true, the answer adds `<m> candidates also match; pass includeCandidates: true to see them.` whenever `m > 0`. `m` is counted with the same predicate and the same all/any mode the answer used, so it costs one extra count query and is omitted when `m = 0`.
- **Propose refusal.** Before the transaction, `planProposal` derives the id of every item that has no `id` and no source match, and collects every `IdWouldTruncate`. If any exist, the call is refused once with:

  ```
  { code: 'id_would_truncate',
    message: "Intent ids are at most 64 characters including the kind prefix; shorten these titles or supply explicit ids.",
    path: <first item's path>,
    issues: [{ path: ['items', i, 'title'], shortenedId }] }
  ```

  Nothing is written. Other refusal codes keep first-failure behaviour.
- **Descriptions.**
  - Tree: "`(a accepted · c candidates)` counts a node's own items; `(empty)` means neither."
  - Search signature lists `includeCandidates?`.
  - `intent_propose` states "ids are at most 64 characters including the kind prefix (`br-`, `dec-`, …); a derived id is refused, never truncated".
  - `title` gets the field description "A few words that state the rule; its slug plus the kind prefix must fit 64 characters."

## Acceptance

| ID | Pass/fail outcome | Observer / validation |
| --- | --- | --- |
| AC-1 | A `query` whose words never co-occur returns no text matches (not any-word matches); `intent_read search` with the same words still returns `matched: 'any'`. | `intent-context.postgres.integration.test.ts`; `intent-read-workspace.postgres.integration.test.ts` |
| AC-2 | A `task` sharing only one incidental word with an item's title no longer returns it; an item sharing two task lexemes with title ∪ statement still does. | `intent-context.postgres.integration.test.ts` |
| AC-3 | `sourceRefs: ['jira:PROD-1','jira:PROD-2']` where only PROD-1 is cited returns `unmatchedSourceRefs: ['jira:PROD-2']` and the text line; a fully matched call omits both. | Same suite |
| AC-4 | A feature holding only candidates prints `(0 accepted · N candidates)`; a feature with neither prints `(empty)`; the header carries both totals. | `intent-read-workspace.postgres.integration.test.ts` (tree case at :337) |
| AC-5 | Search without `includeCandidates` over a topic with only candidate matches prints the hint with the right count; with `includeCandidates: true` there is no hint. | Same suite |
| AC-6 | A batch with two over-long titles is refused once, lists both indices with `shortenedId`, and writes nothing. | `intent-propose.plan.test.ts` plus the propose integration suite |
| AC-7 | The `intent_read` and `intent_propose` descriptions contain the tree marker meaning, `includeCandidates` in the search signature, and the 64-character limit. | `mcp/tools/intent.tools.test.ts` snapshot of the tool list |

**How a check could pass while behaviour is broken:**
- AC-2 passes if the bypass for exact ids also swallows text matches. Assert on `matchReasons`.
- AC-4 passes if candidates are counted from a different predicate than the tree's (for example including archived nodes). Seed an archived candidate and assert it is not counted.

## Implementation plan

| Step | Change boundary | Traces to |
| --- | --- | --- |
| 1 | `intent-context.service.ts`: `allowFallback: false` on the context query path; `relevant` predicate in `selectTaskText` | AC-1, AC-2 |
| 2 | `intent-context.select.ts` / `intent-context.service.ts`: per-ref hit tracking in `selectBySource`; `unmatchedSourceRefs` in the result type, formatter and MCP output | AC-3 |
| 3 | `intent-read.service.ts`: candidate `groupBy` in `tree`; candidate count in `search` | AC-4, AC-5 |
| 4 | `intent-propose.plan.ts` + `intent-id.ts`: derive all ids before the transaction, aggregate `IdWouldTruncate` into `issues` | AC-6 |
| 5 | `intent.tools.ts`: description and `title` field text | AC-7 |

**Validation:** `pnpm --filter @coredoc/server test` (intent unit suites), the intent Postgres integration suites, `pnpm --filter @coredoc/core test` for `derive-id`, and `pnpm check`.

**Reachable failure modes:**
- **Tighter `task` relevance hides a genuinely related item** that shared one title word. That item is still reachable by `sourceRefs`, exact id or node anchor. The coredoc-workflows `coredoc-mcp` skill already tells agents to open the domain node when context is empty.
- **The extra count query on search.** One indexed count per search call.

**Rollout/rollback:**
- A server release, then a `V` bump in day-ai-plugin's `pull-coredoc.yml`.
- No schema change. Rollback is the previous `V`.
- The day-ai-plugin `intent-capture` skill states the 64-character limit in the same release (a separate plugin PR).

## Resolved decisions

- **D-1 — `task` path predicate.** Resolved 2026-10-26 by the owner: apply the rule to the `task` path too, as the shared-lexeme rule in Contracts. The `query` and `task` paths both drop any-word matching.

## Unresolved decisions

NO UNRESOLVED DECISIONS.
