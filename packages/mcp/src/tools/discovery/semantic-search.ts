/**
 * semantic_search Tool Handler — LOCAL stdio surface only, env-gated.
 *
 * Embeds the free-text query with the SAME provider/model that embedded the
 * graph (read from stored per-node provenance), brute-force cosine-ranks it
 * against every stored vector, and returns the top matches. No vector index —
 * at repo scale a full scan is the simplest correct design (KISS).
 *
 * Registered only when ENABLE_SEMANTIC_SEARCH is on (see server.ts); like all
 * local-only tools its schema/description live at the definition site there.
 * Searches the semantic space of AI summaries — never source code.
 */

import { type IGraphReadRepository, type EmbeddedNode } from '@coredoc/db';
import { formatSemanticSearchResults, createMetadata } from '../../response-formatter.js';
import { debug, debugResult } from '../../debug-logger.js';
import { embedQueryText } from './query-embedder.js';
import type {
  ScopeContext,
  OutputFormat,
  McpResponse,
  SemanticSearchResult,
  DetailLevel,
  DetailLevelConfig,
} from '../../types.js';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;

/**
 * Cosine similarity of two equal-length vectors, in [-1, 1].
 * Throws on a length mismatch — ranking across incompatible embedding spaces
 * must fail fast, never silently produce a wrong score.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  // A zero vector has no direction; similarity is defined as 0 (never NaN).
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Handle semantic_search tool
 */
export async function handleSemanticSearch(
  args: Record<string, unknown>,
  scope: ScopeContext,
  format: OutputFormat,
  detailLevel: DetailLevel,
  detailConfig: DetailLevelConfig,
  repository: IGraphReadRepository,
): Promise<McpResponse<SemanticSearchResult[] | string>> {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  // An empty query has nothing to embed —
  // answer with guidance (no provider fetch), not a provider error.
  if (!query) {
    const metadata = await createMetadata(scope, format, detailLevel, detailConfig, repository);
    return {
      data:
        format === 'raw' ? [] : 'Must specify "query" — a natural-language description of the code you are looking for',
      metadata,
      resultCount: 0,
    };
  }
  const requested = Math.floor(Number(args.limit)) || DEFAULT_LIMIT;
  const limit = Math.min(Math.max(requested, 1), MAX_LIMIT);

  debug('getEmbeddedNodes', `hashes=${scope.repoHashes.join(',')}`);
  const embedded = await repository.getEmbeddedNodes(scope.repoHashes);
  debugResult('getEmbeddedNodes', embedded.length);

  const metadata = await createMetadata(scope, format, detailLevel, detailConfig, repository);

  // Honest degradation: embedding generation is a separate, optional step
  // most graphs haven't run — an empty scope is guidance, not an error.
  if (embedded.length === 0) {
    return {
      data:
        format === 'raw'
          ? []
          : `No embeddings are stored for this scope — semantic search has nothing to rank.

Embeddings are generated separately from parsing: run \`coredoc embed\` for the
repo(s) in scope, then re-push the graph. Until then, use search_symbols
(name-based) instead.`,
      metadata,
      resultCount: 0,
    };
  }

  // Provider/model come from stored provenance (first embedded node), NOT from
  // defaults — the query vector must live in the stored vectors' space.
  const { embeddingProvider: provider, embeddingModel: model } = embedded[0]!;
  if (!provider || !model) {
    throw new Error(
      'Stored embeddings carry no provider/model provenance — the query cannot be embedded in the same space. ' +
        'Re-run `coredoc embed` and re-push.',
    );
  }

  // The whole scope must share ONE (provider, model) pair. Same-dimension
  // vectors from different models are numerically comparable but semantically
  // incommensurable — the dimension check below can't catch that, so ranking
  // would silently mix spaces. Fail fast, naming both pairs (same style as the
  // dimension-mismatch error).
  const mixed = embedded.find((node) => node.embeddingProvider !== provider || node.embeddingModel !== model);
  if (mixed) {
    throw new Error(
      `Mixed embedding provenance: "${embedded[0]!.name}" was embedded with "${provider}/${model}", ` +
        `but "${mixed.name}" with "${mixed.embeddingProvider ?? 'unknown provider'}/${mixed.embeddingModel ?? 'unknown model'}" — ` +
        'the vectors do not share one semantic space. Re-run `coredoc embed` with one model across the graph and re-push.',
    );
  }

  const queryVector = await embedQueryText(query, provider, model);

  const ranked = embedded
    .map((node) => ({ node, similarity: similarityOrThrow(queryVector, node, model) }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);

  const results: SemanticSearchResult[] = ranked.map(({ node, similarity }) => ({
    id: node.id,
    name: node.name,
    kind: node.type,
    filePath: node.filePath,
    startLine: node.startLine,
    // Round in the data too, so raw and summary output agree.
    similarity: Math.round(similarity * 100) / 100,
    summary: node.summary,
  }));

  return formatSemanticSearchResults(results, query, embedded.length, metadata);
}

/**
 * Cosine similarity with the fail-fast dimension check surfaced in graph
 * terms: a mismatch means the graph mixes embedding models (or the stored
 * model changed), so the error names BOTH models instead of silently skipping
 * the node.
 */
function similarityOrThrow(queryVector: number[], node: EmbeddedNode, queryModel: string): number {
  if (node.embedding.length !== queryVector.length) {
    throw new Error(
      `Embedding dimension mismatch: the query was embedded with "${queryModel}" (${queryVector.length} dims), ` +
        `but the stored vector for "${node.name}" was generated with "${node.embeddingModel ?? 'unknown model'}" ` +
        `(${node.embedding.length} dims). Re-run \`coredoc embed\` with one model across the graph and re-push.`,
    );
  }
  return cosineSimilarity(queryVector, node.embedding);
}
