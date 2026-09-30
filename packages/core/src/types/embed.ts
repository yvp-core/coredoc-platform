/**
 * Embed Command Types
 *
 * Type definitions for embedding generation command.
 */

export type EmbeddingProvider = 'ollama' | 'openrouter';

export type InputStrategy = 'summary' | 'source' | 'both';

/**
 * Options for the embed command
 */
export interface EmbedOptions {
  /** Config path */
  config: string;
  /** Project id (workspace) */
  projectId?: string;
  /** Repo name or path to parsed JSON file */
  repo: string;
  /** Provider: ollama, openrouter */
  provider: EmbeddingProvider;
  /** Model name */
  model?: string;
  /** API key (OpenRouter) */
  apiKey?: string;
  /** Override base URL */
  baseUrl?: string;
  /** Embedding dimensions */
  dimensions?: number;
  /** Batch size for processing */
  batchSize: number;
  /** Delay between batches in ms */
  delay: number;
  /** Input strategy: summary, source, or both */
  inputStrategy: InputStrategy;
  /** Force re-embedding (ignore cache) */
  force: boolean;
  /** Verbose output */
  verbose: boolean;
  /** Dry run - show what would be processed */
  dryRun: boolean;
  /** Path to summaries file */
  summariesPath?: string;
  /** Skip functions */
  noFunctions: boolean;
  /** Skip endpoints */
  noEndpoints: boolean;
}

/**
 * Embedding for a function
 */
export interface FunctionEmbedding {
  /** Function stable ID */
  functionId: string;
  /** Versioned ID for cache invalidation */
  versionedId: string;
  /** Function name */
  name: string;
  /** File path */
  filePath: string;
  /** MD5 checksum of input text (for incremental updates) */
  inputChecksum: string;
  /** The input text used for embedding */
  inputText: string;
  /** The embedding vector */
  embedding: number[];
  /** ISO timestamp when embedding was generated */
  generatedAt: string;
}

/**
 * Embedding for an endpoint
 */
export interface EndpointEmbedding {
  /** Endpoint stable ID */
  endpointId: string;
  /** Versioned ID for cache invalidation */
  versionedId: string;
  /** Endpoint type (http, graphql, etc.) */
  type: string;
  /** Endpoint path or name */
  path: string;
  /** Handler function ID */
  handlerId: string;
  /** MD5 checksum of input text (for incremental updates) */
  inputChecksum: string;
  /** The input text used for embedding */
  inputText: string;
  /** The embedding vector */
  embedding: number[];
  /** ISO timestamp when embedding was generated */
  generatedAt: string;
}

/**
 * Statistics for embedding run
 */
export interface EmbedStats {
  /** Total functions in the repo */
  totalFunctions: number;
  /** Total endpoints in the repo */
  totalEndpoints: number;
  /** Functions embedded in this run */
  functionsEmbedded: number;
  /** Endpoints embedded in this run */
  endpointsEmbedded: number;
  /** Functions skipped due to cache hit */
  functionsSkipped: number;
  /** Endpoints skipped due to cache hit */
  endpointsSkipped: number;
  /** Failed embeddings */
  failed: number;
  /** Total processing time in milliseconds */
  processingTimeMs: number;
}

/**
 * Output file schema: {repoName}-embeddings.json
 */
export interface EmbeddingsOutput {
  /** Repo stable ID */
  repoId: string;
  /** Repo name */
  repoName: string;
  /** ISO timestamp of when embeddings were generated/updated */
  generatedAt: string;
  /** Provider used */
  provider: EmbeddingProvider;
  /** Model used */
  model: string;
  /** Embedding dimensions */
  dimensions: number;
  /** Input strategy used */
  inputStrategy: InputStrategy;
  /** Function embeddings */
  functions: FunctionEmbedding[];
  /** Endpoint embeddings */
  endpoints: EndpointEmbedding[];
  /** Statistics from the embedding run */
  stats: EmbedStats;
}

/**
 * Provider configuration
 */
export interface ProviderConfig {
  provider: EmbeddingProvider;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  dimensions?: number;
}

/**
 * Item to be embedded (generic interface for batching)
 */
export interface EmbedItem {
  /** Unique identifier */
  id: string;
  /** Versioned ID */
  versionedId: string;
  /** Type of item */
  type: 'function' | 'endpoint';
  /** Name for display */
  name: string;
  /** File path or endpoint path */
  path: string;
  /** Handler ID (for endpoints) */
  handlerId?: string;
  /** Endpoint type (for endpoints) */
  endpointType?: string;
  /** Input text to embed */
  inputText: string;
  /** MD5 checksum of input text */
  inputChecksum: string;
}
