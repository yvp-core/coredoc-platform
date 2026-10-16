---
name: intent-capture
description: Propose reviewed product intent (`intent_propose`) and execute its approval: when a PRD, spec, ADR or product decision is approved, to bootstrap brownfield intent, or for a maintainer's review. Do not use to read intent (`intent_read`/`get_intent_context`); never infer acceptance from code or from your own recommendation. Invoked by `coredoc-prd` or `coredoc-spec` when a person approves the PRD, the PRD-less specification or the ADR (`spec accept` for a standalone spec); run it standalone only for an already-approved document.
---

# Propose product intent as candidates

A person decides authority. Proposals enter as candidates. Execute only an explicit decision: approval of the source document — the approved PRD, the specification accepted when no PRD exists, or the approved ADR — for its unchanged verbatim items (§7.0), or approval of the exact review cards (§7.1). That approval is the acceptance; nobody is asked twice. Implementation never accepts; a change that must contradict accepted intent proposes a successor (`proposedSuccessorOfId`). Never infer approval from code or from your own recommendation.

## 1. The write surface

Product intent lives in a cloud workspace. The workspace MCP exposes `intent_propose` / `intent_review` / `intent_tree` / `intent_anchor`; use those tools only. The authenticated workspace *is* the product — never send, ask for, or invent a `projectId`. Without those tools there is no write surface: say so and stop. There is no local fallback, and no file to edit instead.

**Sessions.** Tree, review, anchor and source-update writes run only in the acting person's own session (any workspace member). A service-token session may read and propose; for anything else it drafts the change in the reply and stops. Later sections say "per §1" for this rule.

If the cloud answers "this workspace has no product intent yet", create the first domain yourself with `intent_tree` (`domain.create`) per §1, and say what you created.

## 2. Source and placement

- **The source must be reviewed and finalized**: a merged spec section, an ADR, an explicit product decision from the user, or a ticket they point at. Code, tests, AI summaries, and the graph can *support* a statement; they cannot *be* the source of one. The one exception is bootstrap mode (§4), where unreviewed evidence is classified and framed explicitly. If it is not decided yet, say so and stop.
- **Placement:** an item attaches to the product root, one `domainId`, or one `featureId`. Read the tree with `intent_read tree` first. Reuse a node that honestly fits; otherwise the missing domain or feature is yours to create per §5 before you propose into it, and you name what you created and placed there.

## 3. Draft the proposals

`intent_propose` item fields:

| field | value |
|---|---|
| `id` | **normally omit** — the server derives a slug from the title; supply one only when a derivation refusal asks for it, or for a same-batch `{item}` reference |
| `kind` | `capability` \| `use_case` \| `flow` \| `business_rule` \| `limitation` \| `decision` |
| `title` | a few words that state the rule, **not a sentence** (`Refund window is 30 days`, not `Refund window`) |
| `statement` | ONE sentence, self-contained: it must read without its body or payload |
| `body` | optional Markdown lines for everything else (use-case bullets, flow steps, a diagram) |
| `rationale` | optional; why this is the rule |
| `payload` | **optional** structured detail, validated per kind (table below) |
| `appliesWhen` | optional context conditions (below); `[]` clears them |
| `domainId` / `featureId` | at most one placement; both absent = the product root |
| `proposedSuccessorOfId` | only when this candidate is meant to replace a specific accepted item |
| `sources[]` | `{ kind: spec\|issue\|adr\|manual, ref, localId, revision?, locator?, title?, url? }`, at least one; `title`+`url` on every citing item (fix later: `intent_source_update`) |
| `anchorSuggestions[]` | optional `{ repoKey, nodeId, rationale? }` |

Anything outside the table is refused, and a refusal writes nothing. Decide these before the call:

- **Source identity is exact `(ref, localId)`, workspace-wide.** Make `ref` repo-qualified, `<repoKey>:<path>`: two repositories can both hold `docs/spec.md` with a `BR-1`, and an unqualified path overwrites the other repository's candidate. Propose upserts on the pair, so keep it stable across runs and precise per statement.
- **Ids are immutable.** A semantic rename is a new item (`proposedSuccessorOfId`) plus the maintainer's supersede decision, never an edited id.
- **Never build a node id yourself.** Anchor suggestions send `repoKey` + `nodeId` + a reason; suggest only ids you read out of tool output, never one reconstructed from a file path.

On you — nothing checks these:

- **Statements only.** Never paste source bodies, prompts, transcripts, file contents, credentials, or long quotes. Preserve the approved statement and its restrictions within the contract's field limits; do not copy the surrounding document.
- **One concept per item.** Two sources describing the same concept stay two items.
- **Granularity test.** A row is intent only if a product owner would recognise it without reading code. Flags, paths, types, function names and release-scoping notes are not intent: propose nothing for them.
- **Placement fit.** When nothing declared honestly fits, park the item at the closest node and name the placement you would propose in the hand-off; never stretch a statement to fit a slot.

Payload per `kind` (optional, validated when present):

| `kind` | `payload` fields |
|---|---|
| `capability` | `outcome`, `beneficiary`, `boundary` |
| `use_case` | `primaryActor`, `trigger`, `preconditions[]`, `successOutcome`, `failureOutcomes[]` |
| `flow` | `trigger`, `terminationCondition`, `steps[]` = `{ id, actor, action, outcome, branches?: [{ condition, toStepId }] }` |
| `business_rule` | `condition`, `requiredOutcome`, `observer`, `exceptions?[]`, `variants?[]` = `{when?: {country: "de"}, outcome, inputs?[]}` |
| `limitation` | `constraint`, `reason`, `affects` |
| `decision` | `question`, `choice`, `choiceStatus` (`open`, `choice` absent \| `proposed` \| `accepted`), `rationale`, `alternatives[]`, `consequences[]` |

`choiceStatus` describes the product choice, not your authority over it — an accepted ADR choice still enters as a `candidate`.

### Context conditions and variants

- Conditions come only from dimension values the approved text names; nothing named → unconditional. Never ask the user per dimension. A condition no dimension expresses goes in `{text}`, which is never evaluated.
- The item applies only in some contexts → `appliesWhen`. One rule with a different outcome per context (40h in DE, a formula elsewhere) → `business_rule.variants`, not `exceptions`.
- `requiredOutcome` is the outcome when no variant matches; add a `when`-less variant only when that default differs.
- Custom roles are not dimension values: condition on the permissions they grant. A boolean setting is a two-value dimension.
- No OR across dimensions: `in:[a,b]` covers alternatives within one dimension; otherwise split the item.
- Clause syntax, inheritance and refusals: `references/tree.md`.

## 4. Bootstrap mode — brownfield packets

Use only when the user explicitly asks to bootstrap or inventory inherited intent. It produces candidates only, through the ordinary propose path: bootstrap is a flow over propose, never a separate write path.

Precondition on an EMPTY workspace: every packet attaches to a domain, so first name the domain set and create it per §1, then send packets.

1. **One packet, one slice** — one domain and one risk theme. Risk-first order: auth/tenant isolation, money, deletion and data loss, privacy, then compliance, before low-risk explanatory context. Never scan a whole product into one packet.
2. **Inventory exact source identities**, each with a named owner and one class: `A` explicit current product decision (approved spec/ADR, owner's decision); `B` maintained product evidence (user/API docs, release or support contract); `C` observed implementation (code, tests, config, telemetry, graph, AI summary); `D` stale or unknown provenance. A class is provenance — never a confidence score, never acceptance.
3. **Framing follows class; check it by hand before proposing.** A/B may frame a `product_candidate`; C/D may only frame `observed_behavior` or `question`. A class-D source must appear in an explicit conflict entry naming the question and its `decisionOwner`. Each candidate's `proposal.sources` must exactly match its classified `sourceIds`, and every `proposal.domainId` must be the packet's domain; a packet `feature` sets every `featureId`.
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

**Validate the packet by hand before any propose call** against the checks above. On a failed check, fix the packet, never route around it. Send **only `candidates[].proposal`** through `intent_propose`; omit wrapper, classes, owners and conflicts.

Re-running bootstrap on the same source revision is safe: matching source identities update those candidates instead of duplicating them. Put the revision in every `sources[].revision` to identify source changes. Report source-class counts, conflicts and their decision owners, unanchored candidates, and the open owner questions. Bootstrap never accepts anything.

## 5. Propose a feature layout with seeds

Split a domain into features only when a domain-wide answer is too broad and each feature earns it: two to five seeds and a real placement need, never one "to hold" one batch. Read each domain (`intent_read node`), group by meaning into roadmap-sized features, and propose the layout in your reply first: per feature its `domainId`, title, one-sentence statement and the items you would move.

Seeds are exact graph node ids you read from tool output (`search_symbols`, `describe_repository`, an existing anchor), two to five per feature; prefer containers a reader would point at (a package, a directory module, an entrypoint) over functions. A feature without seeds derives nothing.

Then, per §1, create each feature with `intent_tree` (nesting, layout: `references/tree.md`), put its seeds, and re-propose the candidates you move with their new `featureId`; an accepted item moves only as a successor candidate plus a supersede decision, so report it as parked. Link nodes a reader of one should also read with `relation.put` and a one-sentence `why`. Report what you created, the seeds accepted, the items moved and parked, then re-read one moved item to show it derives through its feature. Placement is not authority.

## 6. Propose

One `intent_propose` call per batch with a fresh `idempotencyKey` (reuse a key only when retrying that exact call after a transport failure). Read the result: each entry gives `itemId`, `outcome` (`created_candidate` / `updated_candidate`), the new `version`, whether the id was derived, and any accepted items sharing a source identity that were left untouched. Carry those exact ids and versions forward — review decides against them.

A refusal means nothing was written: fix the batch and re-send, never work around the refusal.

## 7. Review — only on an explicit decision

### 7.0 Single approval from an approved document

A person's explicit approval of a PRD, of a specification accepted when no PRD exists, or of an ADR is the decision for its unchanged verbatim items. A specification derived from an approved PRD accepts nothing of its own; an authorized resumption reuses the recorded approval. A file an agent marked accepted is not evidence of a human decision.

1. Before the first write, record the exact proposal, its `idempotencyKey` and the approval reference in the coredoc-workflows session handoff (not the `intent_handoff` tool) or, when there is no session handoff, state it in the reply, so an interrupted run can resume from it.
2. Propose each item with the section's complete statement, condition, scope and exceptions — `business_rule.payload.exceptions` and `limitation.payload.affects` preserve its restrictions — and `sources.revision` set to the approved commit or content digest. Paraphrases and inferences remain candidates.
3. Read back those exact ids and current versions and compare the whole content and `sources.revision` with the approved section.
4. For the items that match, call `intent_review` with `authorizingSource` naming that section and revision, a source-grounded reason, and those `expectedVersion` values. No second card approval is needed. A supersede qualifies only when the section explicitly names the replaced id; read both versions first.
5. On interruption, read back the known ids or replay the same proposal with the same key; never duplicate accepted items.

The session follows §1, never a service-token permission upgrade. If the host refuses the authority change, report the refusal and stop that write; do not bypass it. Unknown approval, changed content or an ambiguous replacement goes to the cards below. A version change alone can be rechecked against the same approved content; changed content needs a new decision.

### 7.1 Show the exact review set (when §7.0 does not qualify)

Take the exact ids from the propose result or the user's request; do not rediscover, fuzzy-match, or expand them. Make one `get_intent_context` call with those `intentIds` and `includeCandidates: true`.

The tool's output — never a raw read of stored content — is the review surface. If a requested id is unknown or the result is truncated, stop rather than present a partial set. Fetch each item's full payload, sources, anchors, and evidence *before* recommending anything: a concise card is a presentation layer over a complete read. At most ten cards; beyond that, ask for a smaller set.

One card per item: exact id and its `version`; title or one-sentence meaning; current authority and the proposed outcome (`accept`, `reject`, `supersede` with one exact pair, `defer`, `needs_edit`); the recommendation and its reason; source `ref` and `localId` plus the source revision or a `missing source revision` warning; and the one material owner question, if a decision still hangs on one. Show graph/evidence status once for the batch, not per card, and keep authority, anchor status, and freshness separate — an anchor never licenses acceptance.

Then **stop and wait**. Ask for a product decision in ordinary language, not tool payloads. A generic "looks good", or any approval given before this exact preview, does not authorize a review.

### 7.2 Execute the card decision

Build the call yourself; never ask the maintainer to construct one. Ask only for what is theirs to supply: the authorizing source (`kind`, `ref`, `localId`, and `revision` for a spec; optional for other kinds) and optionally the work item.

One `intent_review` call with a fresh `idempotencyKey`, one `authorizingSource` for the batch and one decision per item; `expectedVersion` is the version you showed on that card.

- `accept`, `reject`, and `supersede` change authority. **Reject is real**: a rejected item is recorded as rejected.
- `defer` and `needs_edit` are reported outcomes that write nothing. Say so plainly and carry the guidance in the conversation or work item; never claim a transition that did not happen.
- **One provenance group per batch** — only decisions authorized by the same source and work item travel together. Several approved groups run as several calls, in the shown order, stopping on the first failure.
- Never add an unshown id, change an approved outcome, combine unrelated provenance, or silently retry a failure.

**Version conflict** (refused for that item, nothing written): re-fetch **only the exact shown ids**, show what changed and the new versions, and get a NEW decision — the earlier approval does not carry over to refreshed content. Other items in the batch are decided on their own merits, so read the per-item results rather than assuming all-or-nothing.

### 7.3 Verify and hand off

1. Read back the exact reviewed ids (`get_intent_context`) and confirm each one's authority and version.
2. Report every outcome, the non-mutating `defer` / `needs_edit` ones included, with before/after versions.
3. Name any placement you would propose (a domain or feature that does not exist yet) and the items you parked because of it.
4. Carry the exact ids and observed versions unchanged into any spec, plan, ticket, or review prose that follows.

Readback or validation failure stops the workflow; it is never converted into a success claim. Authority decisions belong to the maintainer; this skill executes only the approved decisions described in §7.
