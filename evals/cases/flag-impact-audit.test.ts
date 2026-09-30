import { describe, expect, it } from 'vitest';
import type { AgentRunResult, Target } from '../harness/types.js';
import { flagImpactAuditCase, type FlagImpactAuditParams } from './flag-impact-audit.js';

const target = { name: 'demo-workspace' } as Target;
const params: FlagImpactAuditParams = {
  hook: 'useRuntimeGate',
  hookFile: 'frontend/src/hooks/useRuntimeGate.ts',
  expectedCallSites: ['GatedWidget'],
};

function runWith(responseText: string): AgentRunResult {
  return {
    responseText,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 0,
      costUsd: 0,
    },
    latencyMs: 0,
    toolCalls: [],
    transcriptPath: '',
    error: null,
  };
}

describe('flagImpactAuditCase.verify', () => {
  it('awards the grounding bonus only when the hook definition file is cited', async () => {
    const withoutHookFile = await flagImpactAuditCase.verify(
      target,
      params,
      runWith('`GatedWidget` branches on the result in `frontend/src/GatedWidget.tsx`.'),
    );
    const withHookFile = await flagImpactAuditCase.verify(
      target,
      params,
      runWith(
        '`GatedWidget` branches on the result. Definition: `demo/frontend/src/hooks/useRuntimeGate.ts`.',
      ),
    );

    expect(withoutHookFile.details.hook_file_cited).toBe(0);
    expect(withoutHookFile.score).toBe(80);
    expect(withHookFile.details.hook_file_cited).toBe(1);
    expect(withHookFile.score).toBe(100);
  });

  it('scores an empty answer as zero', async () => {
    const result = await flagImpactAuditCase.verify(target, params, runWith('No call sites found.'));

    expect(result.details.hook_file_cited).toBe(0);
    expect(result.score).toBe(0);
  });
});
