// Structure guard for the coredoc-mcp skill's repo-membership gate.
//
// The graph MCP can be workspace-scoped (HTTP) or carried into a repo by a
// stale/copied config, so the tools stay "available" in directories the graph
// has never seen — and then every answer silently describes ANOTHER project.
// The skill text is the only place that turns that into a loud refusal, so a
// rewrite that drops the gate must fail here, not in production confusion.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const skillPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'skills',
  'coredoc-mcp',
  'SKILL.md',
);
const body = readFileSync(skillPath, 'utf-8');

test('the skill gates graph use on current-repo membership', () => {
  assert.match(body, /current (working )?repo(sitory)? is among/i);
  assert.match(body, /does not cover this repo/i);
});

test('a non-member repo means results describe other projects, loudly', () => {
  assert.match(body, /describe (an)?other project/i);
  assert.match(body, /say so|state (this|that) explicitly/i);
});

test('the gate names the workspace-scoped transport as the reason tools stay available', () => {
  assert.match(body, /workspace-scoped|workspace MCP|copied `?\.mcp\.json`?/i);
});

test('the description ends with the stage-close read-gate sentence', () => {
  const description = body.match(/^description: (.*)$/m)[1];
  assert.match(
    description,
    /Grep, Glob and Read do not satisfy a code question this workspace's MCP can answer; the implement and review stage closes count Coredoc reads, not writes\.$/,
  );
});
