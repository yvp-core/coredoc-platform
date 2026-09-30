import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { generateText, type LanguageModel } from 'ai';

/**
 * Supported LLM providers for summarization.
 *
 * Named providers are reached by their enum value. A custom OpenAI-compatible
 * endpoint can also be passed as a full `https://…` string in {@link LlmConfig.provider}
 * (used by the CI env path), or via {@link LlmConfig.baseURL} on a named provider.
 */
export enum LlmProvider {
  Anthropic = 'anthropic',
  OpenAI = 'openai',
  OpenRouter = 'openrouter',
  Ollama = 'ollama',
}

/** Default Ollama OpenAI-compatible endpoint (local). */
const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434/v1';

export interface LlmConfig {
  /** An {@link LlmProvider} value, or a custom OpenAI-compatible base URL ("https://…"). */
  provider: string;
  /** API key. Not required for Ollama (a placeholder is sent). */
  apiKey: string;
  /** Model id, e.g. "anthropic/claude-haiku-4-5-20251001" or "qwen2.5-coder:7b". */
  model: string;
  /** Override the provider base URL (Ollama host / OpenAI-compatible endpoint). */
  baseURL?: string;
}

/**
 * Normalize an Ollama base URL to its OpenAI-compatible "/v1" endpoint.
 * Accepts "http://host:11434" or "http://host:11434/v1" (trailing slash tolerant).
 */
export function normalizeOllamaBaseUrl(url: string): string {
  const trimmed = url.replace(/\/+$/, '');
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
}

export function createModel(config: LlmConfig): LanguageModel {
  switch (config.provider) {
    case LlmProvider.Ollama: {
      // Ollama exposes an OpenAI-compatible API and needs no real key.
      const ollama = createOpenAI({
        baseURL: config.baseURL ? normalizeOllamaBaseUrl(config.baseURL) : DEFAULT_OLLAMA_BASE_URL,
        apiKey: config.apiKey || 'ollama',
      });
      // .chat() pins the Chat Completions endpoint. The default callable resolves
      // to the Responses API (/responses) since @ai-sdk/openai v3, which most
      // OpenAI-compatible backends (incl. older Ollama) do not implement.
      return ollama.chat(config.model);
    }
    case LlmProvider.OpenRouter: {
      requireApiKey(config);
      const openrouter = createOpenAI({
        baseURL: 'https://openrouter.ai/api/v1',
        apiKey: config.apiKey,
      });
      return openrouter.chat(config.model);
    }
    case LlmProvider.OpenAI: {
      requireApiKey(config);
      const openai = createOpenAI({
        apiKey: config.apiKey,
        ...(config.baseURL && { baseURL: config.baseURL }),
      });
      return openai.chat(config.model);
    }
    case LlmProvider.Anthropic: {
      requireApiKey(config);
      const anthropic = createAnthropic({
        apiKey: config.apiKey,
        ...(config.baseURL && { baseURL: config.baseURL }),
      });
      return anthropic(config.model);
    }
    default: {
      if (!config.provider.startsWith('http')) {
        const known = Object.values(LlmProvider)
          .map((p) => `"${p}"`)
          .join(', ');
        throw new Error(`Unknown LLM provider: "${config.provider}". Use ${known}, or a custom URL (https://...).`);
      }
      requireApiKey(config);
      const custom = createOpenAI({
        baseURL: config.provider,
        apiKey: config.apiKey,
      });
      return custom.chat(config.model);
    }
  }
}

function requireApiKey(config: LlmConfig): void {
  if (!config.apiKey) {
    throw new Error(
      `API key is required for provider "${config.provider}". Pass --api-key or set COREDOC_LLM_API_KEY.`,
    );
  }
}

/**
 * Validate connectivity / auth / model availability with a tiny generation
 * before launching a long batch.
 *
 * The provider-agnostic summarizer (ci-summarizer) returns low-confidence
 * fallback summaries instead of throwing, so without this a local misconfig
 * (Ollama not running, model not pulled, bad key) would silently produce a file
 * full of "LLM call failed" summaries. Preflight fails fast with a clear error.
 */
export async function preflightModel(model: LanguageModel, label: string): Promise<void> {
  try {
    await generateText({ model, prompt: 'Reply with: ok', maxOutputTokens: 8, maxRetries: 0 });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`LLM preflight failed for ${label}: ${msg}`);
  }
}
