// Skill text is read into the agent's context on every use, so size is a real
// cost. These bounds exist so the next change is a rewrite rather than an append;
// raise one only with a reason.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const SKILL = readFileSync(new URL('../skills/intent-capture/SKILL.md', import.meta.url), 'utf8');
const TREE = readFileSync(new URL('../skills/intent-capture/references/tree.md', import.meta.url), 'utf8');

test('intent-capture stays within its context budget', () => {
  const description = SKILL.match(/^description: (.*)$/m)?.[1] ?? '';
  assert.ok(description.length > 0, 'SKILL.md lost its description front matter');
  assert.ok(description.length <= 600, `the description is ${description.length} chars; keep it near 500`);
  const bytes = Buffer.byteLength(SKILL, 'utf8');
  assert.ok(bytes > 8_000, `SKILL.md is only ${bytes} B — it looks truncated, not edited`);
  assert.ok(bytes <= 17_920, `SKILL.md is ${bytes} B, over the 17,920 B budget`);
  assert.ok(Buffer.byteLength(TREE, 'utf8') <= 4_608, 'references/tree.md grew past 4.5 KiB; split or trim it');
});
