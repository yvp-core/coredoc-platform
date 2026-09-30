import { describe, expect, it } from 'vitest';
import type { AgentRunResult, Target } from '../harness/types.js';
import {
  transitiveCallersClosureCase,
  type TransitiveCallersClosureParams,
} from './transitive-callers-closure.js';

const target = { name: 'demo-workspace' } as Target;

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

function params(expectedClosure: string[]): TransitiveCallersClosureParams {
  return {
    symbol: 'rootFunction',
    filePath: 'src/root.ts',
    expectedClosure,
  };
}

describe('transitiveCallersClosureCase.verify', () => {
  it('excludes the deprecated root from legacy truth', async () => {
    const result = await transitiveCallersClosureCase.verify(
      target,
      params(['rootFunction', 'directCaller']),
      runWith('Depth 1\n- `directCaller` — `src/direct-caller.ts`'),
    );

    expect(result.details.truth).toEqual(['directCaller']);
    expect(result.details.excluded_truth_root).toEqual(['rootFunction']);
    expect(result.score).toBe(100);
  });

  it('ignores callers outside the promised maximum depth', async () => {
    const result = await transitiveCallersClosureCase.verify(
      target,
      params(['directCaller', 'tooDeep']),
      runWith(
        'Depth 1\n- `directCaller` — `src/direct-caller.ts`\n\nDepth 4\n- `tooDeep` — `src/too-deep.ts`',
      ),
    );

    expect(result.details.cited).toEqual(['directCaller@src/direct-caller.ts#1']);
    expect(result.details.recall).toBe(0.5);
    expect(result.score).toBe(65);
  });

  it('requires every scored caller to be qualified by a file path', async () => {
    const result = await transitiveCallersClosureCase.verify(
      target,
      params(['directCaller']),
      runWith('Depth 1\n- `directCaller` calls the root.'),
    );

    expect(result.details.cited).toEqual([]);
    expect(result.score).toBe(0);
  });

  it('keeps same-named callers in different files distinct for precision', async () => {
    const result = await transitiveCallersClosureCase.verify(
      target,
      params(['SharedCaller']),
      runWith(
        'Depth 1\n- `SharedCaller` — `src/a/shared.ts`\n- `SharedCaller` — `src/b/shared.ts`',
      ),
    );

    expect(result.details.cited).toEqual([
      'SharedCaller@src/a/shared.ts#1',
      'SharedCaller@src/b/shared.ts#1',
    ]);
    expect(result.details.precision).toBe(0.5);
    expect(result.details.recall).toBe(1);
    expect(result.score).toBe(85);
  });
});
