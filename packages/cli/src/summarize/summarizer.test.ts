/**
 * Tests for the function summarizer parse path.
 *
 * We mock the Claude Agent SDK's query() async-generator so we can drive
 * the summarizer through happy and failure paths without hitting the network.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { FunctionNode, SourceLocation } from '@coredoc/core/types';

// Mock the SDK. Declared before imports so vi.mock hoists correctly.
const queryMock = vi.fn();
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: unknown[]) => queryMock(...args),
}));

import { FunctionSummarizer } from './summarizer';

function makeFn(overrides: Partial<FunctionNode> = {}): FunctionNode {
  const location: SourceLocation = {
    filePath: 'src/service.ts',
    startLine: 10,
    endLine: 20,
  };
  return {
    id: 'repo1:fn:src/service.ts:doWork',
    versionedId: 'repo1:fn:src/service.ts:doWork@abc123',
    name: 'doWork',
    kind: 'function',
    fileId: 'repo1:file:src/service.ts',
    isAsync: false,
    isGenerator: false,
    parameters: [],
    location,
    sourceCode: 'function doWork() { return 42; }',
    ...overrides,
  };
}

/** Make the mocked query() yield one assistant message with the given text. */
function yieldText(text: string) {
  queryMock.mockReturnValue(
    (async function* () {
      yield {
        type: 'assistant',
        message: { content: [{ text }] },
      };
    })(),
  );
}

/** Make the mocked query() yield nothing (empty stream). */
function yieldNothing() {
  queryMock.mockReturnValue(
    (async function* () {
      // no messages
    })(),
  );
}

describe('function summarizer parse path', () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it('returns a parsed summary when JSON is valid', async () => {
    yieldText(
      JSON.stringify({
        detailed_summary: 'Does the work.',
        purpose: 'do work',
        business_logic: ['step 1'],
        side_effects: [],
        data_handling: 'none',
        confidence_level: 'high',
        unknowns: [],
      }),
    );
    const summarizer = new FunctionSummarizer({});
    const fn = makeFn();

    const result = await summarizer.summarize(fn, []);

    expect(result.purpose).toBe('do work');
    expect(result.functionId).toBe(fn.id);
    expect(result.versionedId).toBe(fn.versionedId);
    expect(result.confidence_level).toBe('high');
  });

  it('throws when the response is not parseable JSON', async () => {
    yieldText('this is not json at all');
    const summarizer = new FunctionSummarizer({});
    const fn = makeFn();

    await expect(summarizer.summarize(fn, [])).rejects.toThrow(/Failed to parse AI response as JSON/);
  });

  it('throws when the response stream yields nothing', async () => {
    yieldNothing();
    const summarizer = new FunctionSummarizer({});
    const fn = makeFn();

    await expect(summarizer.summarize(fn, [])).rejects.toThrow(/No response from model/);
  });
});
