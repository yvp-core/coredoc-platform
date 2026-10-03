// Structure guard for the intent-capture skill.
//
// The skill is the only sanctioned authoring path into product intent. Its
// load-bearing content is PROCEDURE and PROHIBITIONS the tools cannot enforce:
// never capture from code or inference, never invent a node id, never accept on
// the maintainer's behalf, stop and wait for a decision. Prose like that is
// deleted by a well-meaning edit without anything failing, so it is asserted
// here. The tool descriptions in apps/server/src/mcp/tools/intent.tools.ts own
// the contract (fields, refusals, permissions); the skill must not restate it,
// and this file does not pin it.
//
// Assertions target invariants (a rule, a tool name, a section boundary) and
// tolerate rewording where they can; a failing match means a rule moved or
// vanished, not that a sentence changed.
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const SKILL_URL = new URL('../skills/intent-capture/SKILL.md', import.meta.url);
const SKILL = readFileSync(SKILL_URL, 'utf8');
const DESCRIPTION = SKILL.match(/^description: (.*)$/m)?.[1] ?? '';
/** SKILL.md byte ceiling: the 2026-10-03 size rounded up to the next 256 B. */
const BUDGET = 17_920;

/** Text of the section that starts at `heading` and ends at the next heading of the same level. */
function section(heading) {
  const start = SKILL.indexOf(heading);
  assert.notEqual(start, -1, `SKILL.md no longer contains the section: ${heading}`);
  const rest = SKILL.slice(start + heading.length);
  const end = rest.search(/\n## /);
  return end === -1 ? rest : rest.slice(0, end);
}

test('the front matter keeps the triggers and steers away from reading and deciding', () => {
  assert.match(SKILL, /^---\nname: intent-capture\ndescription: /);
  for (const trigger of [/PRD/, /spec/, /ADR/, /bootstrap/i, /review/i]) {
    assert.match(DESCRIPTION, trigger, `the description lost the trigger ${trigger}`);
  }
  // Reading intent is a DIFFERENT job; capture must not be selected for it.
  assert.match(DESCRIPTION, /Do not use to read intent \(`intent_read`\s*\/\s*`get_intent_context`\)/);
  assert.match(DESCRIPTION, /never infer acceptance from code or from your own recommendation/);
  assert.ok(DESCRIPTION.length <= 600, `the description is ${DESCRIPTION.length} chars; keep it near 500`);
});

test('the description ends with the invocation-trigger sentence', () => {
  assert.match(
    DESCRIPTION,
    /Invoked by `coredoc-prd` or `coredoc-spec` when a person approves the PRD, the PRD-less specification or the ADR \(`spec accept` for a standalone spec\); run it standalone only for an already-approved document\.$/,
  );
});

test('the opening puts the decision with a person and names both approval paths', () => {
  const opening = SKILL.slice(SKILL.indexOf('# Propose product intent'), SKILL.indexOf('## 1.'));
  assert.match(opening, /A person decides authority/);
  assert.match(opening, /Never infer approval from code or from your own recommendation/);
  assert.match(opening, /§7\.0/);
  assert.match(opening, /§7\.1/);
  assert.match(opening, /proposedSuccessorOfId/);
});

test('the write surface is the workspace tools, with no local fallback and no projectId', () => {
  const surface = section('## 1. The write surface');
  for (const tool of ['`intent_propose`', '`intent_review`', '`intent_tree`', '`intent_anchor`']) {
    assert.ok(surface.includes(tool), `the write surface no longer names ${tool}`);
  }
  assert.match(surface, /`projectId`/);
  assert.match(surface, /say so and stop/);
  assert.match(surface, /no local fallback/i);
});

test('the session rule is stated once, in §1, and referred to elsewhere', () => {
  const surface = section('## 1. The write surface');
  assert.match(surface, /acting person's own session \(any workspace member\)/);
  assert.match(surface, /service-token session may read and propose/);
  assert.match(surface, /drafts the change in the reply and stops/);
  // An empty workspace is the agent's to seed, under the same rule.
  assert.match(surface, /no product intent yet/);
  assert.match(surface, /create the first domain yourself with `intent_tree`/);

  // Stated once: no other section repeats the service-token clause, they point back.
  const afterSurface = SKILL.slice(SKILL.indexOf('## 2.'));
  assert.doesNotMatch(afterSurface, /service-token session (drafts|may)/);
  for (const heading of ['## 5. Propose a feature layout with seeds', '### 7.0 Single approval from an approved document']) {
    const body = heading.startsWith('## 5') ? section(heading) : SKILL.slice(SKILL.indexOf(heading), SKILL.indexOf('### 7.1'));
    assert.match(body, /§1/, `${heading} no longer refers back to the §1 session rule`);
  }
});

test('the source rule forbids code, tests and inference as sources, bootstrap excepted', () => {
  const source = section('## 2. Source and placement');
  assert.match(source, /reviewed and finalized/);
  assert.match(source, /can \*support\*/);
  assert.match(source, /cannot \*be\* the source/);
  assert.match(source, /not decided yet, say so and stop/);
  assert.match(source, /bootstrap mode \(§4\)/);
});

test('placement reads the tree first and makes a missing node the agent\'s to create', () => {
  const source = section('## 2. Source and placement');
  assert.match(source, /`intent_read tree` first/);
  assert.match(source, /honestly fits/);
  assert.match(source, /yours to create per §5/);
});

test('drafting keeps one refusal sentence plus only the rules that change the call', () => {
  const draft = section('## 3. Draft the proposals');
  assert.match(draft, /Anything outside the table is refused, and a refusal writes nothing/);
  // Repo-qualified, stable source identity: the upsert key.
  assert.match(draft, /`\(ref, localId\)`/);
  assert.match(draft, /`<repoKey>:<path>`/);
  assert.match(draft, /stable across runs/);
  // Immutable ids: a rename is a successor, not an edit.
  assert.match(draft, /\*\*Ids are immutable\.\*\*[^\n]*`proposedSuccessorOfId`/);
  // Node ids come out of tool output only.
  assert.match(draft, /Never build a node id yourself/);
  assert.match(draft, /ids you read out of tool output/);
  // Server refusals are the tool description's to state, not restated here.
  assert.doesNotMatch(draft, /No `authority` key|Unknown keys reject/);
});

test('the unenforced drafting rules are labelled as the agent\'s own', () => {
  const draft = section('## 3. Draft the proposals');
  const onYou = draft.indexOf('On you — nothing checks these');
  assert.notEqual(onYou, -1, 'the unenforced rule group is missing');
  // "Statements only" is prompt-only: claiming a tool enforces it would be false.
  assert.ok(draft.indexOf('**Statements only.**') > onYou, 'statements-only must sit in the unenforced group');
  assert.match(draft.slice(onYou), /Preserve the approved statement and its restrictions/);
  assert.match(draft.slice(onYou), /\*\*Granularity test\.\*\*/);
});

test('every source kind and item kind is still listed', () => {
  const draft = section('## 3. Draft the proposals');
  const sourcesRow = draft.split('\n').find((line) => line.startsWith('| `sources[]` |'));
  assert.ok(sourcesRow, 'the field table lost its `sources[]` row');
  for (const kind of ['spec', 'issue', 'adr', 'manual']) {
    assert.ok(sourcesRow.includes(kind), `the source kind list lost ${kind}`);
  }
  for (const kind of ['capability', 'use_case', 'flow', 'business_rule', 'limitation', 'decision']) {
    assert.ok(draft.includes(`\`${kind}\``), `the kind list lost ${kind}`);
  }
  // An accepted ADR still enters as a candidate.
  assert.match(draft, /`choiceStatus` describes the product choice, not your authority over it/);
});

test('the conditions guidance is judgement only', () => {
  const conditions = SKILL.slice(SKILL.indexOf('### Context conditions and variants'), SKILL.indexOf('## 4.'));
  assert.match(conditions, /only from dimension values the approved text names/);
  assert.match(conditions, /Never ask the user per dimension/);
  assert.match(conditions, /`business_rule\.variants`, not `exceptions`/);
  assert.match(conditions, /`requiredOutcome` is the outcome when no variant matches/);
  assert.match(conditions, /Custom roles are not dimension values/);
  assert.match(conditions, /No OR across dimensions/);
  // Declaration and clause syntax belong to the intent_propose / intent_tree descriptions.
  assert.doesNotMatch(conditions, /dimension\.create/);
});

test('bootstrap is opt-in, candidate-only, and rides the ordinary propose path', () => {
  const bootstrap = section('## 4. Bootstrap mode — brownfield packets');
  assert.match(bootstrap, /Use only when the user explicitly asks/);
  assert.match(bootstrap, /bootstrap is a flow over propose, never a separate write path/);
  assert.match(bootstrap, /Bootstrap never accepts anything/);
});

test('bootstrap classes are provenance and gate what may be framed as product', () => {
  const bootstrap = section('## 4. Bootstrap mode — brownfield packets');
  for (const klass of ['`A`', '`B`', '`C`', '`D`']) {
    assert.ok(bootstrap.includes(klass), `the source-class list lost ${klass}`);
  }
  assert.match(bootstrap, /A\/B may frame a `product_candidate`; C\/D may only frame `observed_behavior` or `question`/);
  assert.match(bootstrap, /never a confidence score, never acceptance/);
  assert.match(bootstrap, /class-D source must appear in an explicit conflict entry/);
  assert.match(bootstrap, /Never scan a whole product into one packet/);
  assert.match(bootstrap, /do not rank, merge, or resolve them/);
  assert.match(bootstrap, /it never establishes product truth/);
});

test('the packet is validated before any write and never itself sent to a tool', () => {
  const bootstrap = section('## 4. Bootstrap mode — brownfield packets');
  assert.match(bootstrap, /Validate the packet before any propose call/);
  assert.match(bootstrap, /`parseBrownfieldPacket`/);
  assert.match(bootstrap, /never persisted, never sent to a tool/);
  assert.match(bootstrap, /only `candidates\[\]\.proposal`/);
});

test('the feature layout is short: seeds, proposal first, relations, and placement is not authority', () => {
  const layout = section('## 5. Propose a feature layout with seeds');
  assert.match(layout, /two to five/);
  assert.match(layout, /exact graph node ids you read from tool output/);
  assert.match(layout, /prefer containers/);
  assert.match(layout, /propose the layout in your reply first/);
  assert.match(layout, /never one "to hold" one batch/);
  assert.match(layout, /`relation\.put`[^.]*`why`/);
  assert.match(layout, /Placement is not authority/);
  // Archive, delete and idempotency are the intent_tree description's.
  assert.doesNotMatch(layout, /idempotencyKey|Archive and delete/);
  assert.ok(layout.split('\n').filter(Boolean).length <= 6, '§5 grew past a handful of paragraphs');
});

test('propose demands a fresh idempotency key and carries the result forward', () => {
  const propose = section('## 6. Propose');
  assert.match(propose, /fresh `idempotencyKey`/);
  assert.match(propose, /reuse a key only when retrying that exact call/);
  assert.match(propose, /Carry those exact ids and versions forward/);
  assert.match(propose, /A refusal means nothing was written/);
});

test('single approval reads back, compares, and records recovery state in the session handoff', () => {
  const single = SKILL.slice(SKILL.indexOf('### 7.0'), SKILL.indexOf('### 7.1'));
  assert.match(single, /unchanged verbatim items/);
  assert.match(single, /derived from an approved PRD accepts nothing of its own/);
  assert.match(single, /not evidence of a human decision/);
  assert.match(single, /Paraphrases and inferences remain candidates/);
  // The handoff is the workflow session's, not the intent_handoff tool.
  assert.match(single, /coredoc-workflows session handoff \(not the `intent_handoff` tool\)/);
  assert.match(single, /no session handoff, state it in the reply/);
  // Recovery state is recorded before the first write, i.e. before proposing.
  assert.ok(
    single.indexOf('Before the first write') < single.indexOf('Propose each item'),
    'recording recovery state must come before the propose step',
  );
  assert.match(single, /`sources\.revision` with the approved section/);
  assert.match(single, /Read back those exact ids and current versions/);
  assert.match(single, /`authorizingSource`/);
  assert.match(single, /No second card approval/);
  assert.match(single, /explicitly names the replaced id/);
  assert.match(single, /never duplicate accepted items/);
  assert.match(single, /do not bypass it/);
});

test('the card review shows an exact versioned set, then stops and waits', () => {
  const review = section('## 7. Review — only on an explicit decision');
  assert.match(review, /do not rediscover, fuzzy-match, or expand them/);
  assert.match(review, /never a raw read of stored content/);
  assert.match(review, /stop rather than present a partial set/);
  assert.match(review, /exact id and its `version`/);
  assert.match(review, /an anchor never licenses acceptance/);
  assert.match(review, /Then \*\*stop and wait\*\*/);
  assert.match(review, /A generic "looks good", or any approval given before this exact preview, does not authorize a review/);
});

test('execution is honest about non-mutating outcomes, provenance and conflicts', () => {
  const review = section('## 7. Review — only on an explicit decision');
  assert.match(review, /`expectedVersion` is the version you showed on that card/);
  assert.match(review, /\*\*Reject is real\*\*/);
  assert.match(review, /`defer` and `needs_edit` are reported outcomes that write nothing/);
  assert.match(review, /never claim a transition that did not happen/);
  assert.match(review, /One provenance group per batch/);
  assert.match(review, /Never add an unshown id, change an approved outcome, combine unrelated provenance, or silently retry a failure/);
  assert.match(review, /re-fetch \*\*only the exact shown ids\*\*/i);
  assert.match(review, /the earlier approval does not carry over to refreshed content/);
});

test('the hand-off never rounds a failure up and leaves authority with the maintainer', () => {
  const review = section('## 7. Review — only on an explicit decision');
  assert.match(review, /never converted into a success claim/);
  assert.match(review, /Authority decisions belong to the maintainer/);
});

test('the skill stays within its context budget', () => {
  // Skill bodies are read into the agent's context on every capture, so length
  // is a real cost. This bound exists so the NEXT change is a rewrite rather
  // than an append; raise it only with a reason.
  // lowered 2026-10-03: contract restatements moved to the tool descriptions (intent.tools.ts)
  const bytes = Buffer.byteLength(SKILL, 'utf8');
  assert.ok(bytes > 8_000, `SKILL.md is only ${bytes} B — it looks truncated, not edited`);
  assert.ok(bytes <= BUDGET, `SKILL.md is ${bytes} B, over the ${BUDGET} B budget`);
});

test('the plugin copy is byte-identical to the canonical skill', () => {
  // `skills/` is the source of truth and `plugins/coredoc/skills/` is synced
  // from it by `pnpm sync:plugin-skills`.
  const canonical = readFileSync(new URL('../../../skills/intent-capture/SKILL.md', import.meta.url), 'utf8');
  assert.equal(SKILL, canonical, 'plugins/coredoc/skills copy has drifted — run `pnpm sync:plugin-skills`');
});
