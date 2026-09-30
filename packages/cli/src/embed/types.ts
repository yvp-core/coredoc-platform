/**
 * Embed types — single-sourced in @coredoc/core (packages/core/src/types/embed.ts)
 * and re-exported here so the CLI's `./types.js` importers are unaffected.
 */

export type {
  EmbeddingProvider,
  InputStrategy,
  EmbedOptions,
  FunctionEmbedding,
  EndpointEmbedding,
  EmbedStats,
  EmbeddingsOutput,
  ProviderConfig,
  EmbedItem,
} from '@coredoc/core';
