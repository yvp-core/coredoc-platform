# Plan: intent as the source of truth for a product knowledge base

Status: **phases 1–3 implemented, phase 4 implemented in its simplified form** (2026-10-02,
branch `feat/intent-file-like`, uncommitted). Phase 4 replaced the separate review queue with
review inside the browse document; see Phase 4 and As built.

## Goal

Let a team keep its whole product knowledge base in workspace intent instead of
a Markdown tree in a repository: domains and features, with business rules, use
cases, flows, limitations, decisions and open questions, each with sources,
conditions and delivery status, and links between features. People and agents
read and change it only through intent; there is no parallel Markdown copy.

The driver is a pilot that compared two ways of answering product questions
over the same knowledge: a Markdown tree read with Read/Grep, and intent read
through the cloud MCP. With the same data in both, intent reached 81% recall of
required facts against 86% for files, 46% recall of open points against 59%, no
contradictions in either, at about 1.6× the cost per answer. The logs show
three causes for the remaining gap, all in the read tools and the model rather
than in storage:

1. Bounded reads drop items. Reads matched 37–199 items and returned one page,
   and the agent did not know more existed.
2. There are no relations between features, so impact questions miss the
   neighbouring features that the Markdown tree links explicitly.
3. The agent guesses domain ids that do not exist and loses those reads.

Intent already offers what a file tree cannot: freshness without redistributing
files, item-level change and review, a review history per item, and access for
people who do not use git.

## Constraints

- Git-like guarantees come from the existing model, not new machinery. An
  accepted item is immutable; a change is a successor candidate that a person
  accepts with `supersede`. The supersede chain is the content history, and a
  revert is a successor carrying the old content. A "checked by product" mark
  is the `accepted` transition (actor, reason, source), so it cannot go stale
  silently: any wording change creates a new candidate.
- Fail explicit: every bounded read says what it left out and how to get it.
- Intent reads are served by the cloud workspace only; the local MCP
  (`packages/mcp`) has no intent tools.

## Phase 1 — read tools that behave like files

Paths are under `apps/server/src/` unless noted.

1. **Truthful list paging.** In list mode `truncated` is false while
   `nextCursor` is set (`modules/intent/intent-context.service.ts:1398`), and
   there is no `totalMatched`. Set `truncated` whenever another page exists,
   add `totalMatched`/`omittedCount`, and assert both in the list-paging
   integration test (`intent-context.postgres.integration.test.ts` ~1150).
   The lexical-fallback page (`truncated: true`, `nextCursor: null`) gets a
   cursor or an explicit "narrow the query" remedy.
2. **Whole-node read.** A new `get_intent_context` mode `node` (or a separate
   read tool if the schema gets crowded) taking one `domain` or `feature` and
   returning the node as one compact document: title, statement, appliesWhen,
   every accepted item with kind, id, statement, payload, conditions, delivery
   status and source titles, open questions, and the node's relations with
   their reasons. No 20-item cap; a cursor only above a high bound (for example
   300 items), with `truncated` and `nextCursor` stated. This is the "read the
   whole file" step that the file tree wins with.
3. **Tree read.** `intent_tree` has no read action; the tree is REST-only
   (`GET /intent/tree`). Add a read (action `list` under `intent:read`, or a
   `get_intent_context` mode `tree`) returning domains and features with
   titles, one-line statements, item counts and relation counts.
4. **Unknown ids that help.** `domain_not_found` lists declared domains but the
   message is cut at 200 characters (`contract/intent-errors.ts:261-297`).
   Return the declared ids in a structured field outside the bounded message,
   plus up to five nearest matches by id, title and alias. Same for
   `feature_not_found`.
5. **Search covers payload.** Cloud `query` and `task` search title, statement
   and rationale only; local search also covers payload strings. Add payload
   text (flow steps, rule condition/outcome, variants) to cloud search with an
   index that keeps `intent-perf-baseline` within budget.
6. **Descriptions.** State the `limit` bounds, what `nextCursor` means, and the
   recommended order: tree, then node read, then search for cross-cutting
   questions. No wording-pin tests for descriptions.

## Phase 2 — model gaps

1. **Relations between nodes.** The cloud has no relation table; import drops
   relations (`modules/intent/intent-import.service.ts:279`). Add
   `IntentNodeRelation` (workspace, from node, to node, `why` ≤ 500 chars,
   created by/at), where a node is a domain or a feature. Writes through
   `intent_tree` actions `relation.put` / `relation.delete` (human session,
   audited like other tree writes). Reads through the node read and the tree
   read. Undirected for reading, stored once.
2. **Open questions.** Intent has no kind for them. Stored as `limitation`
   items with an "Open:" prefix, agents underused them in the pilot. Either a
   new kind `open_question` (prefix `oq`, payload `question`, `context`,
   `blocks?`) or `decision` with `choiceStatus: open` and an optional `choice`.
   Answering one supersedes it with the answered decision and, where needed,
   proposes the resulting rule.
3. **Delivery status.** Shipped / planned / retired map to release effectivity
   (`effective` / `planned` / `not_effective` or superseded). A node's
   "in progress" is derived from its items and needs no field. Imports write a
   `baseline` release for shipped items and `plan` events for planned ones.
   "Replaces" maps to `proposedSuccessorOfId` plus `supersede` (same kind only).
4. **Code references.** `code:repo/path#symbol` source refs become anchors
   where the path and symbol resolve in the code graph, and a `manual` source
   with the original ref where they do not, so nothing is lost and drift
   detection can use the anchors later.
5. **History reads.** Expose the supersede chain and transitions of an item in
   the node read (`history: [{id, acceptedAt, by, reason}]`, latest first,
   bounded) and in the web item detail, which already shows decision history.
   `IntentAuditEvent` stays write-only until a reader needs it.

## Phase 3 — bulk import

The former `POST intent/import` (since removed) accepted only the JSON overlay,
only into an empty workspace, up to 500 items, without features or relations. A real product KB
is larger: the pilot's already has about 840 items.

1. Extend the import contract to take features, node relations, open
   questions, anchors and release events, and raise the item ceiling, still in
   one transaction into an empty workspace. Bulk propose in batches of 10 stays
   the path for ongoing changes.
2. The export (`GET /intent/export`) carries the same shape, so an import
   followed by an export is a lossless round trip. Teams moving from Markdown
   can then convert in both directions and roll back.
3. Whether a Markdown converter belongs in the CLI is open; until a second
   adopter needs it, converters stay with the adopter.

## Phase 4 — review for non-developers

Planned as a better review queue; built as review inside the browse document instead,
because a queue card shows an item out of the node it belongs to. Prototypes that led there:
`docs/prototypes/intent-review-phase4.html` (queue, superseded) and
`docs/prototypes/intent-browse-document.html` (document, adopted).

1. **Plain-language item view — done, as a document.** The browse centre shows the node as
   its document (layout headings and prose, each item in its slot, Markdown and Mermaid
   rendered, source refs hidden by default). Proposals are marked in place; a candidate that
   replaces an approved item rides on that item as "Change proposed". The detail pane holds
   the word-level was/now diff, sources, code anchors, history and the decision.
2. **"Needs a fix" — done as a hand-off, nothing stored.** The reviewer writes what is wrong
   (or, for an open question, the answer) and copies a prompt for an agent with the workspace
   MCP, which proposes a successor through `intent_propose`; a person approves it in the
   document. Storing review notes waits until something reads them.
3. **Queues by origin — not done.** It becomes a tree filter once items carry an `origin`
   (initial capture, product spec, engineering proposal, changed in production).
4. **Role mismatch — decided.** New member role `product` (rank of `member`). The web offers
   the intent controls to admin, owner and product (`hasIntentAccess`); the server keeps
   letting every member role change intent (BR-1), accepted for now.
5. **Review tab removed.** What it alone offered moved into browse: per-node waiting counts
   in the tree with an "Only with proposals" filter, "Next proposal" (oldest first, across the
   workspace) and "Approve all proposed here" (one decision, optional ticket, batches of 10).

## Later

- Release events from an issue tracker's status (needs the service-token
  decision below).
- Drift from code merges through anchors and `intent_handoff`, feeding the
  "changed in production" queue.

## As built

- Reads: one new tool, `intent_read` {action: tree | node | search}, answering in text
  (`modules/intent/intent-read.service.ts`). `tree` is the folder listing (ids, titles,
  nesting, `(empty)`). `node` renders the node as its Markdown document from the node's
  `layout` (headings, prose lines, item slots) and each item's `statement` and `body`
  lines, plus its conditions, its delivery state when it is not in production, its payload
  when no body spells it out, and (with `refs: true`) its source titles; prose slots carry
  the item id. `refs: false` (default) strips source references, `refs: true` keeps them and
  appends sources not cited inline. Navigation, delivery and inherited-item notes follow a
  `---` line. A replaced item keeps its slot while it is still in production. A node reads
  400 current items per answer; past that it says TRUNCATED and continues with `after` (item
  id). Superseded history is read separately, so it cannot crowd current items out.
  Search uses the lexical matcher `get_intent_context`'s `query` shares
  (`intent-lexical.ts`): every word over title, statement, body and rationale, a `ref:<value>`
  word for an exact source ref, and an any-word fallback flagged `matched: 'any'` when no item
  holds every word; with a total and an `after` cursor.
- Document shape: `layout` on domains and features and `body` on items (migration
  `20261002130000_intent_node_layout_item_body`), writable through `intent_tree`
  create/update, `intent_propose` and the workspace import, carried by the export, and part
  of the release content hash when present; the release preview returns and shows it, so the
  approved hash covers only what the person saw.
- List mode reports `truncated: true` whenever another page exists, `totalMatched` and
  `omittedCount` on a first page it can count (not under a context filter or the any-word
  fallback), and a `remedy` sentence: pass `nextCursor`, or narrow the query.
- Unknown domain/feature ids name the nearest declared ids (or all of them when nothing is
  close) in the message and in details (`intent-node-suggest.ts`).
- Relations: `IntentNodeRelation` (migration `20261002120000_intent_node_relations`),
  `intent_tree` actions `relation.put` / `relation.delete`, removed with their node. The
  canonical-order CHECK compares bytewise (`COLLATE "C"`, migration
  `20261003100000_intent_node_relations_collate_c`), as the service orders the pair; under a
  glibc en_US collation the two disagreed on ids with hyphens.
- Open questions: `decision` with `choiceStatus: open` and no `choice`.
- Bulk import: `POST intent/import/workspace` takes `CloudIntentWorkspaceDocumentV1`
  (`intent-workspace-import.ts`): tree, dimensions, relations, items at accepted / candidate /
  superseded, sources with title and url, and release evidence (one baseline, plans), into an
  empty workspace in one transaction, up to 5,000 items; archived domains and features keep
  their flag.
- Round trip (3.2): `GET intent/export/workspace` returns the content as that same document
  (`intent-workspace-export.ts`), checked with the import's validator before it is returned.
  Importing it into an empty workspace and exporting again gives an identical document,
  pinned by integration tests (including replacement chains X → S → T, rejected proposals and
  item conditions that name them). Every item travels, rejected ones included; a waiting
  candidate whose predecessor another proposal already replaced travels without its pointer.
  It carries content, not history: no versions, actors, transitions, anchors or seeds, and
  delivery as one baseline of what is in production now plus the active plans;
  `GET intent/export` keeps the full projection. Bounded by the import's own ceilings.
  Archived dimensions come back active (the dimension schema has no archived flag).
- Nested features: `IntentFeature.parentFeatureId` (migration
  `20261002140000_intent_feature_parent`). A composite foreign key keeps the parent in the
  same domain; a parent with sub-features cannot be deleted; cycles and moves that would put
  any feature below 8 ancestors (the moved subtree included) are refused
  (`feature_parent_cycle`); a workspace lock serialises re-parenting. Written through `intent_tree` feature
  create/update and the workspace import, carried by the export; `intent_read` nests the tree
  and lists sub-features. Nesting is structural only: conditions and items still inherit from
  the domain to the feature, not from a parent feature.
- Web document read: `GET intent/document?domainId|featureId&includeCandidates` returns the
  node document as structure (sections, blocks, items with authority, version, delivery,
  open-question flag and a riding `pendingSuccessor`), built by the same code as the
  `intent_read` Markdown. Text is returned as written; the page hides refs on its own.
- Ref stripping (agents and web): a parenthesised group counts as citations when every
  `;`-separated part starts with a ref, so `(jira:PROD-1 Step 7, Visibility gate)` and
  `(jira:PROD-1, 2022-01-27)` are hidden; prose blocks and item bodies are stripped whole, so
  a group that wraps onto the next line goes too. URLs, Markdown link targets `](…)` and
  fenced code or diagram blocks are never touched.
- Review in browse: the tree read's `pendingCount` per node (`root` for the product root),
  separate from the summary every context read carries; the detail pane decides one candidate
  (accept, or supersede with both versions); "Approve all" plans the document's proposals
  with `planReviewBatch`. A manual decision's source ref is always `cloud-review` (the
  server records who decided from the token; an email was refused as intent content).
- Roles: `product` in `WorkspaceMemberRole`, assignable; self-scoped reads (analytics,
  metrics, agent sessions, delivery and feedback filters) now scope every role below admin,
  so a new role fails closed instead of seeing the whole workspace.
- Tree counts (1.3): every tree node carries `itemCount` (candidate or accepted items attached
  directly to it) and `pendingCount` (the candidates among them).
- Not done: payload search (neither `get_intent_context` nor `intent_read` searches payload),
  relation counts in the tree read (1.3), alias matching in
  unknown-id suggestions (1.4), history reads (2.5), code refs as anchors (2.4; they import
  as `manual` sources, and the workspace document carries no anchors), queues by origin (4.3), stored review notes (4.2), authoring hints in
  the browse detail pane (only the removed review tab showed them), a ticket on single-item
  approval, and condition inheritance through parent features.

## Open decisions

1. Automated release events: `intent_release` writes need a human session.
   Allow a service token with `intent:release`, or keep automation proposing
   and a person recording.
2. Who may accept intent — resolved for now: the web offers it to admin, owner and
   product; the server accepts every member role. Narrow the server list
   (`INTENT_REVIEWER_ROLES`) if members must be refused too.
3. Whether sub-features inherit their parent feature's conditions and items, as features
   inherit their domain's.
