/**
 * Embedding Providers
 *
 * Factory for creating embedding providers using LangChain.
 * Supports Ollama (local) and OpenRouter (via OpenAI-compatible API).
 */

import { Embeddings } from '@langchain/core/embeddings';
import { OllamaEmbeddings } from '@langchain/ollama';
import { OpenAIEmbeddings } from '@langchain/openai';
import { ProviderConfig, EmbeddingProvider } from './types.js';

/** Default models for each provider */
const DEFAULT_MODELS: Record<EmbeddingProvider, string> = {
  ollama: 'qwen3-embedding:4b',
  openrouter: 'qwen/qwen3-embedding-4b',
};

/** Default base URLs */
const DEFAULT_BASE_URLS: Record<EmbeddingProvider, string> = {
  ollama: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
  openrouter: 'https://openrouter.ai/api/v1',
};

/**
 * Wrapper around LangChain embeddings to provide a consistent interface
 */
export class EmbeddingProviderWrapper {
  private embeddings: Embeddings;
  public readonly provider: EmbeddingProvider;
  public readonly model: string;
  public readonly dimensions: number | undefined;

  constructor(embeddings: Embeddings, config: ProviderConfig) {
    this.embeddings = embeddings;
    this.provider = config.provider;
    this.model = config.model;
    this.dimensions = config.dimensions;
  }

  /**
   * Embed multiple texts in a batch
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    return this.embeddings.embedDocuments(texts);
  }

  /**
   * Embed a single text
   */
  async embedText(text: string): Promise<number[]> {
    return this.embeddings.embedQuery(text);
  }

  /**
   * Get the dimension of embeddings (from first embedding if not configured)
   */
  async getDimensions(): Promise<number> {
    if (this.dimensions) {
      return this.dimensions;
    }
    // Get dimensions from a test embedding
    const testEmbedding = await this.embedText('test');
    return testEmbedding.length;
  }
}

/**
 * Create an embedding provider based on configuration
 */
export function createEmbeddingProvider(config: ProviderConfig): EmbeddingProviderWrapper {
  const model = config.model || DEFAULT_MODELS[config.provider];
  const baseUrl = config.baseUrl || DEFAULT_BASE_URLS[config.provider];

  let embeddings: Embeddings;

  switch (config.provider) {
    case 'ollama':
      embeddings = new OllamaEmbeddings({
        model,
        baseUrl,
      });
      break;

    case 'openrouter': {
      const apiKey = config.apiKey || process.env.OPENROUTER_API_KEY;
      if (!apiKey) {
        throw new Error(
          'OpenRouter API key is required. Set OPENROUTER_API_KEY environment variable or use --api-key option.',
        );
      }
      embeddings = new OpenAIEmbeddings({
        model,
        openAIApiKey: apiKey,
        configuration: {
          baseURL: baseUrl,
          defaultHeaders: {
            'HTTP-Referer': 'https://github.com/coredoc',
            'X-Title': 'coredoc',
          },
        },
      });
      break;
    }

    default:
      throw new Error(`Unknown provider: ${config.provider}`);
  }

  return new EmbeddingProviderWrapper(embeddings, {
    ...config,
    model,
  });
}

/**
 * Get the default model for a provider
 */
export function getDefaultModel(provider: EmbeddingProvider): string {
  return DEFAULT_MODELS[provider];
}

/**
 * Get the default base URL for a provider
 */
export function getDefaultBaseUrl(provider: EmbeddingProvider): string {
  return DEFAULT_BASE_URLS[provider];
}
