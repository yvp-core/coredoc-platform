// Structure guard for the intent-capture skill.
//
// The skill is the only sanctioned authoring path into product intent, and its
// load-bearing content is PROHIBITIONS the tools cannot enforce: never
// hand-edit the overlay, never capture from code or inference, never invent a
// node id, never accept on the maintainer's behalf. Prose like that is deleted
// by a well-meaning edit without anything failing, so it is asserted here.
//
// This file is deliberately structural: it checks that each rule is still
// present and still attributed to the right side of the enforcement line. It
// cannot check that the wording is good.
//
// It was rewritten when the skill went CLOUD-FIRST (`## 1. Pick the lane`,
// `intent_propose`/`intent_review`, the local lane demoted to a stepping stone
// that fails fast after cutover). The previous version asserted the headings of
// the local-only skill and failed every case, which guards nothing.
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const SKILL_URL = new URL('../skills/intent-capture/SKILL.md', import.meta.url);
const SKILL = readFileSync(SKILL_URL, 'utf8');

/** Text of the section that starts at `heading` and ends at the next heading of the same level. */
function section(heading) {
  const start = SKILL.indexOf(heading);
  assert.notEqual(start, -1, `SKILL.md no longer contains the section: ${heading}`);
  const rest = SKILL.slice(start + heading.length);
  const end = rest.search(/\n## /);
  return end === -1 ? rest : rest.slice(0, end);
}

test('the skill still declares itself, and the front matter steers away from reading and deciding', () => {
  assert.match(SKILL, /^---\nname: intent-capture\ndescription: /);
  const frontMatter = SKILL.slice(0, SKILL.indexOf('\n---\n', 4));
  // Reading intent is a DIFFERENT skill; capture must not be selected for it.
  assert.match(frontMatter, /Do not use to read intent/);
  assert.match(frontMatter, /never infer acceptance from code or from your own recommendation/);
});

test('the opening still puts the decision with the maintainer, not the agent', () => {
  const opening = SKILL.slice(SKILL.indexOf('# Propose product intent'), SKILL.indexOf('## 1.'));
  assert.match(opening, /A person decides authority/);
  assert.match(opening, /Never infer approval from code or from your own recommendation/);
  // Both approved-document and card paths execute a person's decision (BR-2).
  assert.match(opening, /only an explicit decision/);
  assert.match(opening, /unchanged verbatim items[\s\S]*exact review cards/);
});

test('lane selection is cloud-first and decided by the write surface, not convenience', () => {
  const lane = section('## 1. Pick the lane, once');
  assert.match(lane, /Intent is cloud-first/);
  assert.match(lane, /The write surface picks the lane, not convenience/);

  // The cloud lane names its own tools, so "which lane am I in" is answerable
  // from what the session can actually call.
  for (const tool of ['`intent_propose`', '`intent_review`', '`intent_tree`']) {
    assert.ok(lane.includes(tool), `the cloud lane no longer names ${tool}`);
  }
  assert.match(lane, /Cloud lane \(default\)/);
  assert.match(lane, /Local stepping-stone lane/);

  // The workspace IS the product: a projectId in the cloud lane is fabricated.
  assert.match(lane, /never send, ask for, or invent a `projectId`/);
});

test('the cutover error is documented as the lane signal, with no workaround offered', () => {
  const lane = section('## 1. Pick the lane, once');
  assert.match(lane, /After cutover the local lane fails fast/);
  assert.match(lane, /cloud-authoritative/);
  assert.match(lane, /Local \*reads\*.*keep working/);
  // The three specific wrong reactions to that error, refused by name.
  assert.match(lane, /Do not retry, do not pass a flag, do not hand-edit/);
});

test('hand-editing the overlay is still forbidden, and still attributed to the write path', () => {
  const lane = section('## 1. Pick the lane, once');
  assert.match(lane, /\*\*Never hand-edit `\.coredoc\/intent\.json`\*\*/);
  // WHY it is forbidden — the protection lives in the writer, so the file is
  // not equivalent to the command.
  assert.match(lane, /accepted-item protection lives in the write path/);
  assert.match(lane, /a failure of this skill, not a fallback/);
});

test('an empty workspace is the agent\'s to seed in a user session, and a service token stops', () => {
  const lane = section('## 1. Pick the lane, once');
  assert.match(lane, /no product intent yet/);
  // Tree placement is not authority: in the acting user's own session (any
  // member, BR-1) the agent creates the first domain itself and reports it.
  assert.match(lane, /create the first domain yourself with `intent_tree`/);
  assert.match(lane, /in the user's own session \(any workspace member\)/);
  assert.match(lane, /say what you created/);
  // A service token still cannot write the tree — it drafts and stops.
  assert.match(lane, /A service-token session drafts the domain set and stops/);
});

test('the source rule still forbids code, tests, and inference as sources', () => {
  const source = section('## 2. Source and placement');
  assert.match(source, /reviewed and finalized/);
  assert.match(source, /Code, tests, AI summaries, and the graph can \*support\*/);
  assert.match(source, /they cannot \*be\* the source/);
  assert.match(source, /If it is not decided yet, say so and stop/);
  // Bootstrap is the ONE exception, and it is named so it cannot be assumed.
  assert.match(source, /The one exception is bootstrap mode/);
});

test('placement is one node, and makes a missing node the agent\'s to create', () => {
  const source = section('## 2. Source and placement');
  // 2026-09-28: a `domainId` may ride beside a `featureId` as a check (bootstrap packets with a
  // feature); the item still attaches to exactly one node, and propose refuses a mismatched pair.
  assert.match(source, /one `domainId`, or one `featureId` \(a `domainId` beside it must be its domain\)/);
  // Read the tree first, reuse an honest fit, otherwise create the node and
  // say so — not a round trip through the maintainer.
  assert.match(source, /Read the tree with `get_intent_context` first/);
  assert.match(source, /is yours to create per §5 before you propose into it/);
  assert.match(source, /reuse a node that honestly fits first/);
  assert.match(source, /name what you created and placed there/);
});

test('the drafting rules stay split into enforced and unenforced groups', () => {
  const draft = section('## 3. Draft the proposals');
  const enforced = draft.indexOf('Enforced — a violation is a rejection, not a warning');
  const onYou = draft.indexOf('On you — nothing checks these');
  assert.notEqual(enforced, -1, 'the machine-enforced rule group is missing');
  assert.notEqual(onYou, -1, 'the unenforced rule group is missing');
  assert.ok(enforced < onYou, 'the enforced group must come before the group that is on the agent');

  // "Statements only" is prompt-only: claiming a tool enforces it is the
  // specific dishonesty this assertion exists to prevent.
  const statementsOnly = draft.indexOf('**Statements only.**');
  assert.ok(statementsOnly > onYou, 'statements-only must sit in the unenforced group');
  assert.match(draft.slice(onYou), /Preserve the approved statement and its restrictions/);
});

test('the enforced group still names the refusals that write nothing', () => {
  const draft = section('## 3. Draft the proposals');
  assert.match(draft, /No `authority` key/);
  assert.match(draft, /A proposal is a candidate by construction/);
  assert.match(draft, /Unknown keys reject the whole batch/);
  assert.match(draft, /`sources\[\]` identity is exact `\(ref, localId\)`/);
  assert.match(draft, /\*\*Ids are immutable\.\*\*/);
});

test('anchor suggestions are documented as carrying no graph facts', () => {
  const draft = section('## 3. Draft the proposals');
  assert.match(draft, /`anchorSuggestions\[\]`/);
  // The agent sends identity + reason ONLY; type and drift baseline are the
  // server's to resolve, so there is nothing for it to fabricate.
  assert.match(draft, /Anchor suggestions carry no graph facts/);
  assert.match(draft, /node type and the drift baseline are resolved server-side/);
  assert.match(draft, /Never invent or reconstruct a node id from a file path/);
  assert.match(draft, /Suggest only ids you read out of tool output/);
});

test('the local-lane deltas keep anchors off by default and rename the placement field', () => {
  const draft = section('## 3. Draft the proposals');
  const local = draft.slice(draft.indexOf('**Local-lane deltas.**'));
  assert.notEqual(local, '', 'the local-lane delta paragraph is gone');
  // The local format needs a versioned id no read surface exposes for a NEW
  // anchor, so the honest default is to omit them.
  assert.match(local, /omit them by default/);
  assert.match(local, /the placement field is `domain`/);
  assert.match(local, /never into the repo/);
});

test('the allowed source kinds and every item kind are still listed', () => {
  const draft = section('## 3. Draft the proposals');

  // The four kinds live in the `sources[]` row of the field table, inside one
  // backticked shape rather than as separate spans — so the row is located
  // first and the kinds are checked within it.
  const sourcesRow = draft.split('\n').find((line) => line.startsWith('| `sources[]` |'));
  assert.ok(sourcesRow, 'the field table lost its `sources[]` row');
  for (const kind of ['spec', 'issue', 'adr', 'manual']) {
    assert.ok(sourcesRow.includes(kind), `the source kind list lost ${kind}`);
  }
  assert.match(sourcesRow, /at least one/);
  for (const kind of ['capability', 'use_case', 'flow', 'business_rule', 'limitation', 'decision']) {
    assert.ok(draft.includes(`\`${kind}\``), `the kind list lost ${kind}`);
  }
  // An accepted ADR still enters as a candidate: choiceStatus is about the
  // product's choice, never the agent's authority over it.
  assert.match(draft, /`choiceStatus` describes the product choice, not your authority over it/);
});

test('bootstrap is opt-in, produces candidates only, and rides the ordinary propose path', () => {
  const bootstrap = section('## 4. Bootstrap mode — brownfield packets');
  assert.match(bootstrap, /Use only when the user explicitly asks/);
  assert.match(bootstrap, /It produces candidates only/);
  assert.match(bootstrap, /bootstrap is a flow over propose, never a separate write path/);
  assert.match(bootstrap, /Bootstrap never accepts anything/);
});

test('bootstrap source classes stay provenance, and gate what may be framed as product', () => {
  const bootstrap = section('## 4. Bootstrap mode — brownfield packets');
  for (const klass of ['`A`', '`B`', '`C`', '`D`']) {
    assert.ok(bootstrap.includes(klass), `the source-class list lost ${klass}`);
  }
  // The core honesty rule: observed implementation may not be dressed up as a
  // product decision.
  assert.match(bootstrap, /A\/B may frame a `product_candidate`; C\/D may only frame `observed_behavior` or `question`/);
  assert.match(bootstrap, /A class is provenance — never a confidence score, never acceptance/);
  assert.match(bootstrap, /class-D source must appear in an explicit conflict entry/);
});

test('bootstrap keeps its slice bounded, its conflicts intact, and the graph subordinate', () => {
  const bootstrap = section('## 4. Bootstrap mode — brownfield packets');
  assert.match(bootstrap, /One packet, one slice/);
  assert.match(bootstrap, /Never scan a whole product into one packet/);
  assert.match(bootstrap, /Keep conflicts intact/);
  assert.match(bootstrap, /do not rank, merge, or resolve them/);
  assert.match(bootstrap, /The graph finds questions, not answers/);
  assert.match(bootstrap, /it never establishes product truth/);
});

test('the packet is validated before any write, and never itself sent to a tool', () => {
  const bootstrap = section('## 4. Bootstrap mode — brownfield packets');
  assert.match(bootstrap, /Validate the packet before any propose call/);
  assert.match(bootstrap, /`parseBrownfieldPacket`/);
  assert.match(bootstrap, /fix the packet, never route around it/);
  // The wrapper is scaffolding: classes, owners and conflicts are not item
  // content and must not be persisted as if they were.
  assert.match(bootstrap, /scratchpad only; never persisted, never sent to a tool/);
  assert.match(bootstrap, /only `candidates\[\]\.proposal`/);
});

test('the feature layout is proposed and then created in the same user session, minus archive and delete', () => {
  const layout = section('## 5. After import — propose a feature layout with seeds');
  assert.match(layout, /you propose it in your reply, then you create it/);
  assert.match(layout, /in the acting user's own session/);
  // A service token still drafts and stops, and a feature must still earn its
  // existence rather than become a container for one batch.
  assert.match(layout, /a service-token session drafts the layout and stops/);
  assert.match(layout, /never create one "to hold" one batch/);
  // Destructive tree actions stay on an explicit instruction naming the node.
  assert.match(layout, /Archive and delete are the exception: only on an explicit maintainer instruction naming the node/);
  assert.match(layout, /moving an item between a domain and a feature is placement, not authority/);
});

test('propose still demands a fresh idempotency key and a read of the result', () => {
  const propose = section('## 6. Propose');
  assert.match(propose, /fresh `idempotencyKey`/);
  assert.match(propose, /reuse a key only when retrying that exact call/);
  assert.match(propose, /`created_candidate` \/ `updated_candidate`/);
  // Review decides against these exact ids and versions.
  assert.match(propose, /Carry those exact ids and versions forward/);
  assert.match(propose, /A non-zero exit means nothing was written/);
});

test('the review ceremony shows an exact set, then stops and waits for a real decision', () => {
  const review = section('## 7. Review — only on an explicit decision');
  assert.match(review, /do not rediscover, fuzzy-match, or expand them/);
  // The adapter output is the review surface — never a raw read of the file.
  assert.match(review, /never a direct read of the file/);
  assert.match(review, /stop rather than present a partial set/);
  assert.match(review, /Then \*\*stop and wait\*\*/);
  // A blanket approval, or one given before the cards, authorizes nothing.
  assert.match(review, /A generic "looks good", or any approval given before this exact preview, does not authorize a review/);
});

test('the review cards carry the version each decision will be made against', () => {
  const review = section('## 7. Review — only on an explicit decision');
  assert.match(review, /exact id and its `version`/);
  assert.match(review, /`expectedVersion` is the version you showed on that card/);
  // An anchor is not evidence of acceptance.
  assert.match(review, /an anchor never licenses acceptance/);
});

test('execution reports non-mutating outcomes honestly and refuses to mix provenance', () => {
  const review = section('## 7. Review — only on an explicit decision');
  assert.match(review, /\*\*Reject is real\*\*/);
  // defer/needs_edit write NOTHING — claiming a transition would be a lie.
  assert.match(review, /`defer` and `needs_edit` are reported outcomes that write nothing/);
  assert.match(review, /never claim a transition that did not happen/);
  assert.match(review, /One provenance group per batch/);
  assert.match(review, /Never add an unshown id, change an approved outcome, combine unrelated provenance, or silently retry a failure/);
});

test('a version conflict forces a NEW decision rather than reusing the old approval', () => {
  const review = section('## 7. Review — only on an explicit decision');
  assert.match(review, /Re-fetch \*\*only the exact shown ids\*\*/);
  assert.match(review, /get a NEW decision/);
  assert.match(review, /the earlier approval does not carry over to refreshed content/);
});

test('the local lane still has no review verb, and the hand-off refuses acceptance', () => {
  const review = section('## 7. Review — only on an explicit decision');
  assert.match(review, /there is no local review verb/);
  assert.match(review, /acceptance is the maintainer's own reviewed edit/i);
  assert.match(review, /present the cards, hand off, and edit nothing yourself/i);
  // A failed readback is never rounded up to success.
  assert.match(review, /never converted into a success claim/);
  assert.match(review, /Authority decisions belong to the maintainer/);
  assert.match(review, /executes only the approved decisions/);
});

test('the skill stays within its context budget', () => {
  // Skill bodies are read into the agent's context when the skill is invoked,
  // so length is a real cost paid on every capture. The cloud-first rewrite
  // roughly doubled sections 1 and 6; this bound exists so the NEXT change is a
  // rewrite rather than an append. Raise it only with a reason.
  // raised 2026-09-15 for the DEC-4 gate sentence appended to the description (workflow-gates spec issue 04); the body was not trimmed because §7 authority rules are load-bearing
  const bytes = Buffer.byteLength(SKILL, 'utf8');
  assert.ok(bytes > 8_000, `SKILL.md is only ${bytes} B — it looks truncated, not edited`);
  // raised 2026-09-23 for intent-flow-v2: approval-at-document (BR-2), member sessions (BR-1) and the granularity test; the opening was trimmed first
  // raised 2026-09-26 for intent-dimensions: appliesWhen/variants capture guidance (step 9, AC-9); the addition was compacted three times first
  // raised 2026-09-28 for intent-dimensions: evidence-only conditions rule (no per-dimension questions)
  // raised 2026-09-28 for pilot review: item-clause reach, same-batch ids, requiredOutcome vs variant.outcome, boolean settings
  assert.ok(bytes <= 23_296, `SKILL.md is ${bytes} B, over the 23296 B budget`);
});

test('the description ends with the invocation-trigger sentence', () => {
  const description = SKILL.match(/^description: (.*)$/m)[1];
  assert.match(
    description,
    /Invoked by `coredoc-prd` or `coredoc-spec` when a person approves the PRD, the PRD-less specification or the ADR \(`spec accept` for a standalone spec\); run it standalone only for an already-approved document\.$/,
  );
});

test('the plugin copy is byte-identical to the canonical skill', () => {
  // `skills/` is the source of truth and `plugins/coredoc/skills/` is synced
  // from it by `pnpm sync:plugin-skills`. A drift means agents loading the
  // plugin get different rules from the ones asserted above.
  const canonical = readFileSync(new URL('../../../skills/intent-capture/SKILL.md', import.meta.url), 'utf8');
  assert.equal(SKILL, canonical, 'plugins/coredoc/skills copy has drifted — run `pnpm sync:plugin-skills`');
});
