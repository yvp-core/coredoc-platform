/**
 * Tests for the semantic_search tool handler (env-gated, local-only).
 *
 * The repository is mocked via createMockRepository; the query-embedding HTTP
 * call is mocked via a stubbed global fetch (Ollama /api/embed shape).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleSemanticSearch, cosineSimilarity } from './semantic-search.js';
import type { ScopeContext, DetailLevel, DetailLevelConfig, SemanticSearchResult } from '../../types.js';
import { createMockRepository, createMockEmbeddedNode } from '../../__tests__/fixtures/mock-repository.js';

// Mock database (handler + response-formatter both import getRepository; the
// repository is always injected explicitly as the 6th handler arg here).
vi.mock('@coredoc/db', () => ({
  getRepository: vi.fn(),
}));

const defaultDetailLevel: DetailLevel = 'full';
const defaultDetailConfig: DetailLevelConfig = {
  includeBasic: true,
  includeSummaries: true,
  includeRefs: true,
  includeFullDetails: true,
};

const mockScope: ScopeContext = {
  currentPath: '/test/repo',
  resolvedRepos: ['test-repo'],
  repoHashes: ['abc123def456'],
  crossRepoEnabled: false,
};

/** Stub global fetch with an Ollama /api/embed success response. */
function stubOllamaEmbed(queryVector: number[]): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ embeddings: [queryVector] }),
    text: async () => '',
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('cosineSimilarity', () => {
  it('is 1 for identical vectors', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
  });

  it('is 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it('is -1 for opposite vectors', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1);
  });

  it('is scale-invariant', () => {
    expect(cosineSimilarity([1, 1], [10, 10])).toBeCloseTo(1);
  });

  it('is 0 (not NaN) when a vector is all zeros', () => {
    expect(cosineSimilarity([0, 0], [1, 2])).toBe(0);
  });

  it('throws on a dimension mismatch (fail fast, no silent skip)', () => {
    expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow(/dimension mismatch: 2 vs 3/i);
  });
});

describe('semantic_search Tool Handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('ranks results by cosine similarity, best first, with 2-decimal scores', async () => {
    stubOllamaEmbed([1, 0]);
    const mockRepo = createMockRepository({
      getEmbeddedNodes: vi
        .fn()
        .mockResolvedValue([
          createMockEmbeddedNode({ id: 'h:function:a.ts:far', name: 'far', embedding: [0, 1] }),
          createMockEmbeddedNode({ id: 'h:function:b.ts:exactMatch', name: 'exactMatch', embedding: [1, 0] }),
          createMockEmbeddedNode({ id: 'h:function:c.ts:close', name: 'close', embedding: [0.6, 0.8] }),
        ]),
    });

    const response = await handleSemanticSearch(
      { query: 'rotate auth tokens', format: 'raw' },
      mockScope,
      'raw',
      defaultDetailLevel,
      defaultDetailConfig,
      mockRepo,
    );

    const results = response.data as SemanticSearchResult[];
    expect(results.map((r) => r.name)).toEqual(['exactMatch', 'close', 'far']);
    expect(results.map((r) => r.similarity)).toEqual([1, 0.6, 0]);
    expect(response.resultCount).toBe(3);
    // GUARDRAILS: never expose source code.
    for (const r of results) {
      expect(r).not.toHaveProperty('sourceCode');
    }
  });

  it('renders similarity to 2 decimals and one-line summaries in summary format', async () => {
    stubOllamaEmbed([1, 0]);
    const mockRepo = createMockRepository({
      getEmbeddedNodes: vi.fn().mockResolvedValue([
        createMockEmbeddedNode({
          name: 'rotateToken',
          embedding: [0.6, 0.8],
          summary: 'Rotates the refresh token\nSecond line must not render',
        }),
      ]),
    });

    const response = await handleSemanticSearch(
      { query: 'token rotation' },
      mockScope,
      'summary',
      defaultDetailLevel,
      defaultDetailConfig,
      mockRepo,
    );

    const text = response.data as string;
    expect(text).toContain('Semantic matches for "token rotation"');
    expect(text).toContain('0.60 `rotateToken` (function) - src/auth.ts:42');
    expect(text).toContain('Rotates the refresh token');
    expect(text).not.toContain('Second line must not render');
    expect(response.resultCount).toBe(1);
  });

  it('respects the limit arg, defaulting to 10 and capping at 25', async () => {
    const nodes = Array.from({ length: 30 }, (_, i) =>
      createMockEmbeddedNode({ id: `h:function:f.ts:fn${i}`, name: `fn${i}`, embedding: [1, i / 30] }),
    );
    const mockRepo = createMockRepository({ getEmbeddedNodes: vi.fn().mockResolvedValue(nodes) });

    stubOllamaEmbed([1, 0]);
    const withDefault = await handleSemanticSearch(
      { query: 'q' },
      mockScope,
      'raw',
      defaultDetailLevel,
      defaultDetailConfig,
      mockRepo,
    );
    expect(withDefault.data as SemanticSearchResult[]).toHaveLength(10);

    const withLimit = await handleSemanticSearch(
      { query: 'q', limit: 5 },
      mockScope,
      'raw',
      defaultDetailLevel,
      defaultDetailConfig,
      mockRepo,
    );
    expect(withLimit.data as SemanticSearchResult[]).toHaveLength(5);

    const overCap = await handleSemanticSearch(
      { query: 'q', limit: 100 },
      mockScope,
      'raw',
      defaultDetailLevel,
      defaultDetailConfig,
      mockRepo,
    );
    expect(overCap.data as SemanticSearchResult[]).toHaveLength(25);
  });

  it('guards a missing/empty query with a must-specify response (no fetch, no ranking)', async () => {
    const fetchMock = stubOllamaEmbed([1, 0]);
    const mockRepo = createMockRepository({
      getEmbeddedNodes: vi.fn().mockResolvedValue([createMockEmbeddedNode({ embedding: [1, 0] })]),
    });

    for (const args of [{}, { query: '   ' }]) {
      const response = await handleSemanticSearch(
        args,
        mockScope,
        'summary',
        defaultDetailLevel,
        defaultDetailConfig,
        mockRepo,
      );
      expect(response.data).toContain('Must specify "query"');
      expect(response.resultCount).toBe(0);
    }

    const raw = await handleSemanticSearch({}, mockScope, 'raw', defaultDetailLevel, defaultDetailConfig, mockRepo);
    expect(raw.data).toEqual([]);
    expect(raw.resultCount).toBe(0);

    // Guarded before any graph read or provider call.
    expect(mockRepo.getEmbeddedNodes).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('degrades honestly when the scope has no embedded nodes (guidance, not an error)', async () => {
    const fetchMock = stubOllamaEmbed([1, 0]);
    const mockRepo = createMockRepository({ getEmbeddedNodes: vi.fn().mockResolvedValue([]) });

    const response = await handleSemanticSearch(
      { query: 'anything' },
      mockScope,
      'summary',
      defaultDetailLevel,
      defaultDetailConfig,
      mockRepo,
    );

    expect(response.isError).toBeUndefined();
    expect(response.resultCount).toBe(0);
    const text = response.data as string;
    expect(text).toContain('No embeddings are stored');
    expect(text).toContain('coredoc embed');
    // No embeddings → no query-embedding call is ever made.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws a dimension-mismatch error naming BOTH models (fail fast, no silent skip)', async () => {
    stubOllamaEmbed([1, 0]); // 2-dim query vector
    // Homogeneous provenance (so the mixed-provenance guard passes), but the
    // provider now returns a different dimensionality than what was stored —
    // the query-vs-stored dimension check must still fail fast.
    const mockRepo = createMockRepository({
      getEmbeddedNodes: vi.fn().mockResolvedValue([
        createMockEmbeddedNode({
          name: 'staleNode',
          embedding: [1, 0, 0], // 3-dim stored vector
          embeddingModel: 'model-a',
        }),
      ]),
    });

    await expect(
      handleSemanticSearch({ query: 'q' }, mockScope, 'raw', defaultDetailLevel, defaultDetailConfig, mockRepo),
    ).rejects.toThrow(/dimension mismatch.*model-a.*2 dims.*staleNode.*model-a.*3 dims/s);
  });

  it('throws on mixed embedding models even when dimensions agree, naming both pairs', async () => {
    const fetchMock = stubOllamaEmbed([1, 0]);
    const mockRepo = createMockRepository({
      getEmbeddedNodes: vi.fn().mockResolvedValue([
        createMockEmbeddedNode({
          name: 'first',
          embedding: [1, 0],
          embeddingProvider: 'ollama',
          embeddingModel: 'model-a',
        }),
        // Same 2-dim shape — only the provenance differs. The dimension check
        // cannot catch this; the provenance guard must.
        createMockEmbeddedNode({
          name: 'drifted',
          embedding: [0, 1],
          embeddingProvider: 'ollama',
          embeddingModel: 'model-b',
        }),
      ]),
    });

    await expect(
      handleSemanticSearch({ query: 'q' }, mockScope, 'raw', defaultDetailLevel, defaultDetailConfig, mockRepo),
    ).rejects.toThrow(/model-a.*drifted.*model-b.*coredoc embed/s);
    // Guarded BEFORE the query is embedded — no provider call is made.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('leaves a homogeneous graph unaffected by the mixed-provenance guard', async () => {
    stubOllamaEmbed([1, 0]);
    const mockRepo = createMockRepository({
      getEmbeddedNodes: vi
        .fn()
        .mockResolvedValue([
          createMockEmbeddedNode({ name: 'a', embedding: [1, 0] }),
          createMockEmbeddedNode({ name: 'b', embedding: [0, 1] }),
        ]),
    });

    const response = await handleSemanticSearch(
      { query: 'q' },
      mockScope,
      'raw',
      defaultDetailLevel,
      defaultDetailConfig,
      mockRepo,
    );

    expect(response.resultCount).toBe(2);
  });

  it('embeds the query with the STORED provider/model provenance, not defaults', async () => {
    const fetchMock = stubOllamaEmbed([1, 0]);
    const mockRepo = createMockRepository({
      getEmbeddedNodes: vi
        .fn()
        .mockResolvedValue([
          createMockEmbeddedNode({ embedding: [1, 0], embeddingProvider: 'ollama', embeddingModel: 'custom-model:7b' }),
        ]),
    });

    await handleSemanticSearch({ query: 'q' }, mockScope, 'raw', defaultDetailLevel, defaultDetailConfig, mockRepo);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:11434/api/embed',
      expect.objectContaining({ body: JSON.stringify({ model: 'custom-model:7b', input: 'q' }) }),
    );
  });

  it('fails fast when stored embeddings carry no provider/model provenance', async () => {
    const mockRepo = createMockRepository({
      getEmbeddedNodes: vi
        .fn()
        .mockResolvedValue([
          createMockEmbeddedNode({ embedding: [1, 0], embeddingProvider: undefined, embeddingModel: undefined }),
        ]),
    });

    await expect(
      handleSemanticSearch({ query: 'q' }, mockScope, 'raw', defaultDetailLevel, defaultDetailConfig, mockRepo),
    ).rejects.toThrow(/provenance/);
  });
});
