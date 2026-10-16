/**
 * Embedding Providers
 *
 * Ollama (local) and OpenRouter, both reached through their OpenAI-compatible
 * embeddings endpoint and driven with the AI SDK's embedMany.
 */

import { createOpenAI } from '@ai-sdk/openai';
import type { EmbeddingModel } from 'ai';
import { normalizeOllamaBaseUrl } from '../ci/llm-config.js';
import type { EmbeddingProvider, ProviderConfig } from './types.js';

/** Default models for each provider */
const DEFAULT_MODELS: Record<EmbeddingProvider, string> = {
  ollama: 'qwen3-embedding:4b',
  openrouter: 'qwen/qwen3-embedding-4b',
};

/**
 * Get the default model for a provider
 */
export function getDefaultModel(provider: EmbeddingProvider): string {
  return DEFAULT_MODELS[provider];
}

/**
 * Create the embedding model for a provider configuration.
 */
export function createEmbeddingModel(config: ProviderConfig): EmbeddingModel {
  const model = config.model || DEFAULT_MODELS[config.provider];
  switch (config.provider) {
    case 'ollama':
      // Ollama needs no real key.
      return createOpenAI({
        baseURL: normalizeOllamaBaseUrl(config.baseUrl || process.env.OLLAMA_BASE_URL || 'http://localhost:11434'),
        apiKey: 'ollama',
      }).embedding(model);

    case 'openrouter': {
      const apiKey = config.apiKey || process.env.OPENROUTER_API_KEY;
      if (!apiKey) {
        throw new Error(
          'OpenRouter API key is required. Set OPENROUTER_API_KEY environment variable or use --api-key option.',
        );
      }
      return createOpenAI({
        baseURL: config.baseUrl || 'https://openrouter.ai/api/v1',
        apiKey,
        headers: { 'HTTP-Referer': 'https://github.com/coredoc', 'X-Title': 'coredoc' },
      }).embedding(model);
    }

    default:
      throw new Error(`Unknown provider: ${config.provider}`);
  }
}
