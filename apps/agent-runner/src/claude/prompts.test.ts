import { QuestionsPolicy, ScopeAcceptancePolicy, type TurnAssignment, TurnKind } from '@coredoc/core/agent-runner';
import { describe, expect, it } from 'vitest';
import { assignment } from '../fake-coredoc-api.test-support.js';
import type { BaseCandidates } from '../git/branch-scan.js';
import { implementPrompt, runPreamble, scopePrompt } from './prompts.js';

const PRD = '/work/PRD.md';
const SPEC_SCOPE = '/work/spec.md';
const SPEC = '/work/SPEC.md';

const scopeTurn = (policy = QuestionsPolicy.Pause, notes: string | null = null): TurnAssignment => {
  const base = assignment();
  return assignment({ run: { ...base.run, questionsPolicy: policy, seeds: ['orders-api', 'billing-api'], notes } });
};

const implementTurn = (
  policy = QuestionsPolicy.Pause,
  acceptance = ScopeAcceptancePolicy.Required,
  overrides: Partial<TurnAssignment> = {},
): TurnAssignment => {
  const base = assignment();
  return assignment({
    turn: { ...base.turn, kind: TurnKind.Implement, ordinal: 3 },
    run: { ...base.run, questionsPolicy: policy, scopeAcceptancePolicy: acceptance, notes: 'Leave billing-api alone.' },
    prd: null,
    acceptedSpec: {
      version: 2,
      title: 'Orders export',
      markdown: '# Spec\n',
      acceptedBy: 'member@example.com',
      acceptedAt: '2026-10-10T09:00:00.000Z',
      digest: 'a'.repeat(64),
    },
    ...overrides,
  });
};

const candidates: BaseCandidates = {
  epicKey: 'PROJ-1',
  listings: [{ key: 'orders-api', defaultBranch: 'main', matching: ['feat/PROJ-1-exports'] }],
  unchecked: ['broken-api'],
};

const clones = [
  { key: 'orders-api', path: '/work/orders-api', mergeOrder: 0, withheldPaths: [] },
  { key: 'billing-api', path: '/work/billing-api', mergeOrder: 1, withheldPaths: ['.github/workflows/ci.yml', '.env'] },
];

describe('prompts when the entry skill owns the method', () => {
  const methodRules = [
    /interview/i,
    /Product questions/,
    /developer-owned/,
    /coredoc-workflows/,
    /workflow run/,
    /implement route/,
    /get_intent_context/,
  ];

  it.each([
    ['scope', scopeTurn(), 'acme-agent-run:scope', '- A question parks this session for a person'],
    ['implement', implementTurn(QuestionsPolicy.Assume), 'acme-agent-run:implement', '- No one answers questions'],
  ])('the %s preamble keeps the channel rules and drops the product-question rule, with or without the skill still to invoke', (_kind, turn, skill, channel) => {
    for (const preamble of [runPreamble(turn, skill, true), runPreamble(turn, undefined, true)]) {
      for (const rule of methodRules) expect(preamble).not.toMatch(rule);
      expect(preamble).toContain(
        '- Ask questions only through AskUserQuestion, and only from the main session; subagents return their questions to the main session.',
      );
      expect(preamble).toContain(channel);
      expect(preamble).toContain('Never run git writes');
      expect(preamble).toContain('Run-control tools of this phase');
    }
    expect(runPreamble(turn, skill, true)).toContain(`Start by invoking the skill ${skill}`);
    expect(runPreamble(turn, undefined, true)).not.toContain('Start by invoking');
  });

  it('the scope prompt is the spec path and the propose_scope contract, with the git ban, candidates and notes', () => {
    const prompt = scopePrompt(
      scopeTurn(QuestionsPolicy.Pause, 'Build on feat/PROJ-1-exports.'),
      PRD,
      SPEC_SCOPE,
      candidates,
      true,
    );
    for (const rule of methodRules) expect(prompt).not.toMatch(rule);
    expect(prompt).toContain(
      `\n1. Write the specification to ${SPEC_SCOPE}.\n2. Call mcp__agent_run__propose_scope with the scope; the content of ${SPEC_SCOPE} is proposed`,
    );
    expect(prompt).not.toMatch(/^3\./m);
    expect(prompt).toContain('Do not change any repository and do not run git writes.');
    expect(prompt).toContain('- orders-api: feat/PROJ-1-exports (default branch: main)');
    expect(prompt).toContain('Build on feat/PROJ-1-exports.');
  });

  it('the implement prompt keeps the clones, the approval record, request_repo and submit_result, renumbered', () => {
    const prompt = implementPrompt(implementTurn(), SPEC, PRD, clones, true);
    for (const rule of methodRules) expect(prompt).not.toMatch(rule);
    expect(prompt).toContain('- billing-api: /work/billing-api');
    expect(prompt).toContain('\nApproval record: Version 2, accepted by member@example.com');
    expect(prompt).toMatch(/^1\. Before changing a repository/m);
    expect(prompt).toMatch(/^2\. Never write the specification into a repository/m);
    expect(prompt).toMatch(/^3\. If the change needs a repository .* mcp__agent_run__request_repo/m);
    expect(prompt).toMatch(/^4\. End with mcp__agent_run__submit_result/m);
    expect(prompt).not.toMatch(/^5\./m);
  });
});
