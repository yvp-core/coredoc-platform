---
name: intent-capture
description: Propose reviewed product intent (capabilities, use cases, flows, business rules, limitations, decisions) into a coredoc workspace with `intent_propose`, or into a repo's local overlay with `coredoc intent capture` before cutover; accept the unchanged verbatim items of a document a person has just approved, under that single approval; bootstrap inherited intent from a brownfield codebase as bounded, source-classified packets; and execute a maintainer's explicit review decisions with `intent_review`. Use when a PRD, specification, ADR, or product decision is approved, when asked to bootstrap or inventory existing intent, or when a maintainer asks to review known candidates. Do not use to read intent (`get_intent_context` / `coredoc intent context`), and never infer acceptance from code or from your own recommendation. Invoked by `coredoc-prd` or `coredoc-spec` when a person approves the PRD, the PRD-less specification or the ADR (`spec accept` for a standalone spec); run it standalone only for an already-approved document.
---

# Propose product intent as candidates

A person decides authority. Proposals enter as candidates. Execute only an explicit decision: approval of the source document — the approved PRD, the specification accepted when no PRD exists, or the approved ADR — for its unchanged verbatim items (§7.0), or approval of the exact review cards (§7.1). That approval is the acceptance; nobody is asked twice. Implementation never accepts; a change that must contradict accepted intent proposes a successor (`proposedSuccessorOfId`). Never infer approval from code or from your own recommendation.

## 1. Pick the lane, once

Intent is cloud-first. The write surface picks the lane, not convenience:

- **Cloud lane (default).** The workspace MCP exposes `intent_propose` / `intent_review` / `intent_tree` / `intent_anchor` (only the cloud has these), or `coredoc.config.json` carries `intent: { mode: "cloud", workspaceId }`. Use those tools only. The authenticated workspace *is* the product — never send, ask for, or invent a `projectId`.
- **Local stepping-stone lane.** No cloud intent for this project yet: write with `coredoc intent capture` into `<repoRoot>/.coredoc/intent.json`.

**After cutover the local lane fails fast.** Once the project is imported into a workspace, every local intent *write* verb refuses with an error naming the workspace that owns authority (`Product intent for project "…" is cloud-authoritative: workspace … owns it`). That error is the lane signal: switch to the cloud lane and re-send the same proposal there. Local *reads* (`status`, `list`, `context`) keep working. Do not retry, do not pass a flag, do not hand-edit.

**Never hand-edit `.coredoc/intent.json`** — its accepted-item protection lives in the write path. Editing the file is a failure of this skill, not a fallback. The one edit that is legitimate is the maintainer's own reviewed acceptance before cutover (§7.2), and it is theirs to make, never yours.

If the cloud answers "this workspace has no product intent yet", create the first domain yourself with `intent_tree` (`domain.create`) in the user's own session (any workspace member), and say what you created. A service-token session drafts the domain set and stops.

## 2. Source and placement

- **The source must be reviewed and finalized**: a merged spec section, an ADR, an explicit product decision from the user, or a ticket they point at. Code, tests, AI summaries, and the graph can *support* a statement; they cannot *be* the source of one. The one exception is bootstrap mode (§4), where unreviewed evidence is classified and framed explicitly. If it is not decided yet, say so and stop.
- **Placement (cloud):** an item attaches to the product root, one `domainId`, or one `featureId` (a `domainId` beside it must be its domain). Read the tree with `get_intent_context` first. A domain or feature the tree does not declare is yours to create per §5 before you propose into it — reuse a node that honestly fits first, and name what you created and placed there.

## 3. Draft the proposals

`intent_propose` item fields; anything else is refused, and a refusal writes nothing:

| field | value |
|---|---|
| `id` | **normally omit** — the server derives a kind-prefixed slug from the title (`br-refund-window`); supply one only when a derivation refusal asks for it |
| `kind` | `capability` \| `use_case` \| `flow` \| `business_rule` \| `limitation` \| `decision` |
| `title` | a few words that state the rule, **not a sentence** (`Refund window is 30 days`, not `Refund window`): its slug becomes the id, and a title too long to fit the id cap is refused (pass a shorter title, or an explicit `id`) |
| `statement` | one or two sentences, self-contained: it must read without its payload |
| `rationale` | optional; why this is the rule |
| `payload` | **optional** structured detail, validated per kind (table below) |
| `domainId` / `featureId` | at most one; both absent = the product root |
| `proposedSuccessorOfId` | only when this candidate is meant to replace a specific accepted item |
| `sources[]` | `{ kind: spec\|issue\|adr\|manual, ref, localId, revision?, locator?, title?, url? }`, at least one; `title`+`url` on every citing item (fix later: `intent_source_update`) |
| `anchorSuggestions[]` | optional `{ repoKey, nodeId, rationale? }` |

Enforced — a violation is a rejection, not a warning:

- **No `authority` key.** A proposal is a candidate by construction.
- **Unknown keys reject the whole batch**, which is what keeps prompts, transcripts, and file bodies out of the workspace. Text fields are length-capped; a batch holds at most ten items.
- **`sources[]` identity is exact `(ref, localId)`, scoped to the workspace** — artifact plus position inside it, so `ref` is repo-qualified: `<repoKey>:<path>` (two repositories in one workspace can both hold `docs/spec.md` with a `BR-1`, and an unqualified path would overwrite the other repository's candidate). Propose upserts on it: an explicit `id` updates that candidate, otherwise a matching source identity updates the existing candidate instead of appending a duplicate. Keep the pair stable across runs and precise per statement.
- **Ids are immutable.** Never rename an id to update something; a semantic rename is a new item plus the maintainer's supersede decision. Giving a NEW proposal an id that already exists is a hard refusal.
- **Anchor suggestions carry no graph facts** — you send `repoKey` + `nodeId` and a reason; node type and the drift baseline are resolved server-side. Never invent or reconstruct a node id from a file path; an unresolvable one refuses the batch. Suggest only ids you read out of tool output.

On you — nothing checks these:

- **Statements only.** Never paste source bodies, prompts, transcripts, file contents, credentials, or long quotes. Preserve the approved statement and its restrictions within the contract’s field limits; do not copy the surrounding document.
- **One concept per item.** Two sources describing the same concept stay two items.
- **Granularity test.** A row is intent only if a product owner would recognise it without reading code. Flags, paths, types, function names and release-scoping notes are not intent: propose nothing for them.
- **Placement fit.** When nothing declared honestly fits, park the item at the closest node and name the placement you would propose in the hand-off; never stretch a statement to fit a slot.

Payload per `kind` (optional, validated when present):

| `kind` | `payload` fields |
|---|---|
| `capability` | `outcome`, `beneficiary`, `boundary` |
| `use_case` | `primaryActor`, `trigger`, `preconditions[]`, `successOutcome`, `failureOutcomes[]` |
| `flow` | `trigger`, `terminationCondition`, `steps[]` = `{ id, actor, action, outcome, branches?: [{ condition, toStepId }] }` (a `toStepId` must name a step in the same flow) |
| `business_rule` | `condition`, `requiredOutcome`, `observer`, `exceptions?[]`, `variants?[]` = `{when?: {country: "de"}, outcome, inputs?[]}` (`when` maps dimension → value or value[], not a clause; no `when` = default, ≤1) |
| `limitation` | `constraint`, `reason`, `affects` |
| `decision` | `question`, `choice`, `choiceStatus` (`proposed`\|`accepted`), `rationale`, `alternatives[]`, `consequences[]` |

`choiceStatus` describes the product choice, not your authority over it — an accepted ADR choice still enters as a `candidate`.

**Local-lane deltas.** Same fields and discipline, four differences: write the batch to a scratchpad document `{ "items": [ … ] }` (never into the repo); the placement field is `domain`, a slug the overlay registry already declares (`coredoc intent status`); anchors are full `codeAnchors` needing both a stable node id and its `capturedVersionedId` from tool output, so **omit them by default**; apply with `coredoc intent capture --project <id> --input <scratch>/intent-proposals.json`, then `coredoc intent validate --project <id>`.

### Context conditions and variants

- Item applies only in some contexts → item-level `appliesWhen` (AND-joined `{dimension,in/notIn:[...]}`, `{item:id}`, `{text}`); absent = unconditional.
- One rule, outcome per context (40h in DE, formula elsewhere) → `business_rule.variants`, not `exceptions`.
- Conditions come only from the approved text naming a dimension value; nothing named → unconditional. Never ask per dimension. A condition shared by a domain/feature goes on that node via `intent_tree`, only on an explicit maintainer instruction naming it; propose `hints` are review input, not questions.
- Not expressible on dimensions → `{text}`, never evaluated.
- Declare dimensions first via `intent_tree` `dimension.create` (`id`, `title`, `values: [{id, title, aliases}]`, `multi: true` for sets); undeclared refs fail. Hints match `aliases` only.
- No OR/hierarchies: `in:[a,b]` within a dimension; split the item across dimensions.
- Custom roles aren't dimension values; condition on the permissions they grant.
- `{item}`: one level (the target's effective dimension clauses); filters once the target is accepted (candidate → unevaluated; rejected/superseded refused). Same-batch refs need an explicit `id`.
- `requiredOutcome` = the outcome when no variant matches; add a `when`-less variant only when that default differs. A boolean setting = a two-value dimension.

## 4. Bootstrap mode — brownfield packets

Use only when the user explicitly asks to bootstrap or inventory inherited intent. It produces candidates only, through the ordinary propose path: bootstrap is a flow over propose, never a separate write path.

Precondition on an EMPTY workspace: every packet attaches to a domain, and a tree write needs the acting user's own session. So the first bootstrap runs in a user session — name the domain set, create it with `intent_tree`, then send packets, and report what you created. A service-token session cannot seed the tree; draft the domain set and stop instead of improvising.

1. **One packet, one slice** — one domain and one risk theme. Risk-first order: auth/tenant isolation, money, deletion and data loss, privacy, then compliance, before low-risk explanatory context. Never scan a whole product into one packet.
2. **Inventory exact source identities**, each with a named owner and one class: `A` explicit current product decision (approved spec/ADR, owner's decision); `B` maintained product evidence (user/API docs, release or support contract); `C` observed implementation (code, tests, config, telemetry, graph, AI summary); `D` stale or unknown provenance. A class is provenance — never a confidence score, never acceptance.
3. **Framing follows class, and it is enforced.** A/B may frame a `product_candidate`; C/D may only frame `observed_behavior` or `question`. A class-D source must appear in an explicit conflict entry naming the question and its `decisionOwner`. Each candidate's `proposal.sources` must exactly match its classified `sourceIds`, and every `proposal.domainId` must be the packet's domain; a packet `feature` sets every `featureId`.
4. **The graph finds questions, not answers.** It suggests touchpoints; it never establishes product truth.
5. **Keep conflicts intact** — do not rank, merge, or resolve them. At most ten candidates per packet.

The packet wrapper (scratchpad only; never persisted, never sent to a tool):

```json
{
  "domain": "returns",
  "riskTheme": "money and refund eligibility",
  "sources": [{ "id": "approved-returns-spec", "class": "A", "owner": "Returns owner", "source": { "kind": "spec", "ref": "shop-api:docs/specs/returns.md", "localId": "BR-1", "revision": "abc123" } }],
  "conflicts": [{ "sourceIds": ["approved-returns-spec", "old-returns-wiki"], "question": "Which window is current?", "decisionOwner": "Returns owner" }],
  "candidates": [{ "framing": "product_candidate", "sourceIds": ["approved-returns-spec"], "proposal": { "kind": "business_rule", "domainId": "returns", "title": "Refund window is 30 days", "statement": "…", "sources": [{ "kind": "spec", "ref": "shop-api:docs/specs/returns.md", "localId": "BR-1", "revision": "abc123" }] } }]
}
```

**Validate the packet before any propose call.** `parseBrownfieldPacket` in `@coredoc/core` enforces these checks. Without package access, check manually (`coredoc intent bootstrap-check --input` needs a repo overlay). On refusal, fix the packet, never route around it. Send **only `candidates[].proposal`** through `intent_propose`; omit wrapper, classes, owners and conflicts. In the local lane, keep the identical discipline and copy each validated proposal into the capture document, renaming `domainId` to `domain`, dropping `featureId` and `anchorSuggestions`.

Re-running bootstrap on the same source revision is safe: matching source identities update those candidates instead of duplicating them. Put the revision in every `sources[].revision` to identify source changes. Report source-class counts, conflicts and their decision owners, unanchored candidates, and the open owner questions. Bootstrap never accepts anything.

## 5. After import — propose a feature layout with seeds

Import attaches items to domains because the local format has no features. Propose a feature layout when a domain-wide answer is too broad.

Same rule as domain creation: **you propose it in your reply, then you create it** in the acting user's own session. `intent_tree` needs a user session, so a service-token session drafts the layout and stops. A feature still earns it: two to five seeds and a real placement need; never create one "to hold" one batch.

1. **Read what is there** — `get_intent_context` in `list` mode over the imported domains. Group by meaning. Use roadmap-sized features; a one-feature domain needs no split.
2. **Propose the layout as prose first**, one line per feature: its `domainId`, a short title, and a one-sentence statement. Name the items you would move under each. Keep it to one screen.
3. **Seeds are the point.** A feature without seeds derives nothing — seeds are the code nodes that define the feature's area, and the applicability of every item hangs off them. Propose two to five per feature, each an exact stable node id you got from the graph (`search_symbols`, `describe_repository`, or an existing item's anchor), never a guessed or hand-assembled id. Prefer the containers a reader would point at — a package, a directory-level module, an entrypoint — over individual functions.
4. **Then execute** with `intent_tree`: create each feature, then put its seeds, then move the items. One call per operation with a fresh `idempotencyKey`; a seed naming a repo identity the workspace does not carry is refused with the registered identities listed, which is a fix-the-id signal, not a retry signal. Archive and delete are the exception: only on an explicit maintainer instruction naming the node.
5. **Report the result**: features created, seeds accepted, items moved, and anything you parked. Then re-read one moved item and show that it now derives through its feature — a layout that changes no answer is worth saying so about.

Nothing here accepts, rejects, or re-authorities anything: moving an item between a domain and a feature is placement, not authority.

## 6. Propose

**Cloud.** One `intent_propose` call per batch with a fresh `idempotencyKey` (reuse a key only when retrying that exact call after a transport failure). Read the result: each entry gives `itemId`, `outcome` (`created_candidate` / `updated_candidate`), the new `version`, whether the id was derived, and any accepted items sharing a source identity that were left untouched. Carry those exact ids and versions forward — review decides against them.

**Local.** `coredoc intent capture`, then `coredoc intent validate`. A non-zero exit means nothing was written: fix the document and re-run, never work around the refusal. If capture refuses because the overlay is invalid, report it — that needs a maintainer fix or a Git restore, not a rewrite by you.

## 7. Review — only on an explicit decision

### 7.0 Single approval from an approved document (cloud)

An explicit human approval of a PRD, of a specification accepted when no PRD
exists, or of an ADR is the decision for its unchanged verbatim items; a
specification derived from an approved PRD accepts nothing of its own; an authorized resumption reuses that recorded approval.
A file merely marked accepted by an agent is not evidence of a human decision.
Keep the complete statement, condition, scope and exceptions from that section:
`business_rule.payload.exceptions` and `limitation.payload.affects` must preserve
its restrictions. Keep `sources.revision` (approved commit or content digest)
and the exact source section. Paraphrases and inferences remain candidates.

After proposing, read back those exact IDs and current versions and compare the
whole content with the approved source. For qualifying items, call `intent_review`
with `authorizingSource` naming that section and revision (required by the server for `kind: spec`), a source-grounded reason,
and those `expectedVersion` values. No second card approval is needed. Supersede
qualifies only if the accepted section explicitly names the replaced ID; read
both versions first. Preserve the exact proposal, mutation key and approval
reference in the existing handoff before sending. On interruption, read back
known IDs or replay the same proposal/key; do not duplicate accepted items.

This uses the person's own session, never a
CI/service-token permission upgrade. If the host refuses the authority change, report the refusal and stop
that write; do not bypass it. Unknown approval, changed content or ambiguous
replacement uses the explicit cards below. A version change alone can be
rechecked against the same approved content; changed content needs a new decision.

### 7.1 Show the exact review set (when §7.0 does not qualify)

Take the exact ids from the propose result or the user's request; do not rediscover, fuzzy-match, or expand them. Cloud: one `get_intent_context` call with those `intentIds` and `includeCandidates: true`. Local: one `coredoc intent context --project <id> --include-candidates` with one repeated `--id` per exact id.

The adapter's output — never a direct read of the file — is the review surface. If a requested id is unknown or the result is truncated, stop rather than present a partial set. Fetch each item's full payload, sources, anchors, and evidence *before* recommending anything: a concise card is a presentation layer over a complete read. At most ten cards; beyond that, ask for a smaller set.

One card per item: exact id and its `version`; title or one-sentence meaning; current authority and the proposed outcome (`accept`, `reject`, `supersede` with one exact pair, `defer`, `needs_edit`); the recommendation and its reason; source `ref` and `localId` plus the source revision or a `missing source revision` warning; and the one material owner question, if a decision still hangs on one. Show graph/evidence status once for the batch, not per card, and keep authority, anchor status, and freshness separate — an anchor never licenses acceptance.

Then **stop and wait**. Ask for a product decision in ordinary language, not tool payloads. A generic "looks good", or any approval given before this exact preview, does not authorize a review.

### 7.2 Execute the card decision

Build the call yourself; never ask the maintainer to construct one. Ask only for what is theirs to supply: the authorizing source (`kind`, `ref`, `localId`, and `revision` for a spec; optional for other kinds) and optionally the work item.

**Cloud:** one `intent_review` call, fresh `idempotencyKey`, one `authorizingSource` for the batch, one decision per item — `{ itemId, expectedVersion, action, reason }`, plus `replacementItemId` and `replacementExpectedVersion` on a `supersede`. `expectedVersion` is the version you showed on that card.

- `accept`, `reject`, and `supersede` change authority. **Reject is real**: a rejected item is recorded as rejected.
- `defer` and `needs_edit` are reported outcomes that write nothing. Say so plainly and carry the guidance in the conversation or work item; never claim a transition that did not happen.
- **One provenance group per batch** — only decisions authorized by the same source and work item travel together. Several approved groups run as several calls, in the shown order, stopping on the first failure.
- Never add an unshown id, change an approved outcome, combine unrelated provenance, or silently retry a failure.

**Version conflict.** A decision whose `expectedVersion` no longer matches is refused for that item and writes nothing. Re-fetch **only the exact shown ids**, show what changed and the new versions, and get a NEW decision — the earlier approval does not carry over to refreshed content. Other items in the batch are decided on their own merits, so read the per-item results rather than assuming all-or-nothing.

**Local (pre-cutover only):** there is no local review verb. Authority transitions belong to cloud workspaces. Before a project is imported into a workspace, solo acceptance is the maintainer's own reviewed edit of `.coredoc/intent.json`, followed by `coredoc intent validate -p <id>`. Present the cards, hand off, and edit nothing yourself.

### 7.3 Verify and hand off

1. Read back the exact reviewed ids (`get_intent_context`; locally `coredoc intent context` plus `coredoc intent validate`) and confirm each one's authority and version.
2. Report every outcome, the non-mutating `defer` / `needs_edit` ones included, with before/after versions; in the local lane also show `git diff -- .coredoc/intent.json`.
3. Name any placement you would propose (a domain or feature that does not exist yet) and the items you parked because of it.
4. Carry the exact ids and observed versions unchanged into any spec, plan, ticket, or review prose that follows.

Readback or validation failure stops the workflow; it is never converted into a success claim. Authority decisions belong to the maintainer; this skill executes only the approved decisions described in §7.
