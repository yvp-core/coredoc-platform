/**
 * Tests for the repository summarizer parse path.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ParsedRepo } from '@coredoc/core/types';

const queryMock = vi.fn();
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: unknown[]) => queryMock(...args),
}));

import { RepositorySummarizer } from './repository-summarizer';

function makeRepo(): ParsedRepo {
  return {
    id: 'repo1',
    name: 'repo1',
    path: '/tmp/repo1',
    repoHash: 'abc',
    type: 'backend',
    language: 'typescript',
    packages: [],
    files: [],
    functions: [],
    classes: [],
    interfaces: [],
    types: [],
    enums: [],
    constants: [],
    calls: [],
    imports: [],
    entrypoints: [],
    entities: [],
    externalCalls: [],
    parsedAt: new Date().toISOString(),
    parserVersion: '1.0.0',
  } as unknown as ParsedRepo;
}

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

describe('repository summarizer parse path', () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it('returns a summary when JSON is valid', async () => {
    yieldText(
      JSON.stringify({
        overview: 'A test repo.',
        dataModel: 'none',
        externalIntegrations: ['github'],
      }),
    );
    const summarizer = new RepositorySummarizer({});
    const result = await summarizer.summarize(makeRepo(), []);

    expect(result.overview).toBe('A test repo.');
    expect(result.externalIntegrations).toEqual(['github']);
  });

  it('throws when the response is not parseable JSON', async () => {
    yieldText('totally not json');
    const summarizer = new RepositorySummarizer({});

    await expect(summarizer.summarize(makeRepo(), [])).rejects.toThrow(/Failed to parse AI response as JSON/);
  });
});
