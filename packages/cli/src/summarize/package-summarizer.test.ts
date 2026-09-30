/**
 * Tests for the package summarizer parse path.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ParsedRepo } from '@coredoc/core/types';

const queryMock = vi.fn();
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: unknown[]) => queryMock(...args),
}));

import { PackageSummarizer } from './package-summarizer';

function makeRepo(): ParsedRepo {
  return {
    id: 'repo1',
    name: 'repo1',
    path: '/tmp/repo1',
    repoHash: 'abc',
    type: 'backend',
    language: 'typescript',
    packages: [
      { id: 'pkg:a', name: 'pkg-a', path: 'packages/a', kind: 'library' },
      { id: 'pkg:b', name: 'pkg-b', path: 'packages/b', kind: 'library' },
    ],
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

describe('package summarizer parse path', () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it('returns summaries when JSON array is valid', async () => {
    yieldText(
      JSON.stringify([
        { packageId: 'pkg:a', purpose: 'does a' },
        { packageId: 'pkg:b', purpose: 'does b' },
      ]),
    );
    const summarizer = new PackageSummarizer({});
    const result = await summarizer.summarize(makeRepo(), []);

    expect(result).toHaveLength(2);
    expect(result[0]?.purpose).toBe('does a');
  });

  it('throws when the response is not parseable JSON', async () => {
    yieldText('totally not json');
    const summarizer = new PackageSummarizer({});

    await expect(summarizer.summarize(makeRepo(), [])).rejects.toThrow(/Failed to parse AI response as JSON/);
  });

  it('throws when the parsed JSON is not an array', async () => {
    yieldText(JSON.stringify({ wrong: 'shape' }));
    const summarizer = new PackageSummarizer({});

    await expect(summarizer.summarize(makeRepo(), [])).rejects.toThrow(/Failed to parse AI response as JSON/);
  });
});
