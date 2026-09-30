import { describe, expect, it } from 'vitest';
import { renderEarlyFailure, renderReview, safeText } from './report.js';
import { limitsSchema, type ReviewResult } from './contracts.js';

describe('rendered text safety', () => {
  it('removes control, bidi, zero-width and tag characters that spoof the rendered comment', () => {
    const hidden = `plain‮reversedbell­soft​zero﻿feff${String.fromCodePoint(0xe0041, 0xe007f)}`;
    expect(safeText(hidden)).toBe('plainreversedbellsoftzerofeff');
  });
  it('keeps real line breaks and tabs', () => {
    expect(safeText('first\nsecond\tthird')).toBe('first\nsecond\tthird');
  });
  it('still separates mentions with a zero-width space added after stripping', () => {
    expect(safeText('@team')).toBe('@​team');
  });
});

const sha = (c: string) => c.repeat(40);
const result = (candidates: ReviewResult['candidates']): ReviewResult => ({
  schemaVersion: 1,
  runId: 'test',
  revision: { repository: 'owner/repo', pullNumber: 1, baseSha: sha('a'), mergeBaseSha: sha('a'), headSha: sha('b') },
  mode: 'prospective',
  arm: 'A',
  status: 'completed',
  summary: 'Fixture',
  findings: [],
  candidates,
  verification: [],
  configuration: {
    runtime: 'ai-sdk-7',
    auth: 'api-key',
    model: { provider: 'openai', id: 'test' },
    policyVersion: 'v1',
    policyDigest: 'digest',
    promptVersion: 'v1',
    runnerVersion: 'test',
    limits: limitsSchema.parse({}),
    unsupportedSampling: [],
  },
  coverage: { changed: [], read: [], excluded: [], gaps: [] },
  graph: null,
  usage: {
    steps: 1,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: null,
    costKind: 'unknown',
    durationMs: 0,
  },
});

describe('candidate table', () => {
  it('renders one escaped row per candidate with its anchor, verdict, outcome and reason', () => {
    const report = renderReview(
      result([
        {
          id: 'logic-division',
          lens: 'logic',
          severity: 'P1',
          title: 'Division <b> returns infinity',
          anchor: { path: 'src/a.ts', revision: 'head', line: 12 },
          verdict: 'confirm',
          outcome: 'published',
        },
        {
          id: 'logic-stale',
          lens: 'logic',
          severity: 'P2',
          title: 'Ghost guard',
          anchor: { path: 'src/b.ts', revision: 'base', line: 3 },
          verdict: 'unresolved',
          outcome: 'dropped',
          reason: 'EVIDENCE_EXCERPT_MISMATCH',
        },
      ]),
    );
    expect(report).toContain('| Lens | Severity | Title | Anchor | Verdict | Outcome | Reason |');
    expect(report).toContain(
      '| logic | P1 | Division &lt;b&gt; returns infinity | src/a.ts:12 | confirm | published | — |',
    );
    expect(report).toContain(
      '| logic | P2 | Ghost guard | src/b.ts:3 | unresolved | dropped | EVIDENCE\\_EXCERPT\\_MISMATCH |',
    );
  });
  it('omits the table when discovery produced no candidate', () => {
    expect(renderReview(result([]))).not.toContain('**Candidates**');
  });
});

describe('auth rendering', () => {
  it('shows the api-key header and run-configuration line', () => {
    const report = renderReview(result([]));
    expect(report).toContain('· auth: api-key');
    expect(report).toContain('Auth: api-key');
  });
  it('shows the subscription header and run-configuration line', () => {
    const withSubscription: ReviewResult = {
      ...result([]),
      configuration: { ...result([]).configuration, auth: 'subscription', runtime: 'claude-agent-sdk' },
    };
    const report = renderReview(withSubscription);
    expect(report).toContain('· auth: subscription');
    expect(report).toContain('Auth: subscription (Claude Code OAuth token; no provider cost is reported)');
  });
});

describe('renderEarlyFailure', () => {
  it('renders the mapped sentence for a known code', () => {
    const text = renderEarlyFailure('MODEL_CREDENTIAL_MISCONFIGURED');
    expect(text).toContain('# Coredoc review — incomplete');
    expect(text).toContain(safeText('MODEL_CREDENTIAL_MISCONFIGURED'));
    expect(text).toContain('Configure exactly one model credential');
  });
  it('renders the fallback sentence for an unmapped code', () => {
    const text = renderEarlyFailure('SOMETHING_UNKNOWN');
    expect(text).toContain(
      `${safeText('SOMETHING_UNKNOWN')}\`: the run failed before a review was produced; see the failed step.`,
    );
  });
});
