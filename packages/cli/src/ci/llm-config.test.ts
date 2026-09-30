import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LanguageModel } from 'ai';
import { createModel, normalizeOllamaBaseUrl, preflightModel, LlmProvider } from './llm-config.js';

// Mock only generateText (used by preflightModel). createModel relies on
// @ai-sdk/* factories, not on the 'ai' runtime, so it is unaffected.
vi.mock('ai', () => ({
  generateText: vi.fn(),
}));
import { generateText } from 'ai';
const mockGenerateText = vi.mocked(generateText);

describe('llm-config', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createModel', () => {
    it('should create OpenRouter model with correct base URL', () => {
      const model = createModel({
        provider: 'openrouter',
        apiKey: 'test-key',
        model: 'anthropic/claude-haiku-4-5-20251001',
      });
      expect(model).toBeDefined();
      expect(model.modelId).toBe('anthropic/claude-haiku-4-5-20251001');
    });

    it('should create OpenAI model', () => {
      const model = createModel({ provider: 'openai', apiKey: 'test-key', model: 'gpt-4o-mini' });
      expect(model).toBeDefined();
      expect(model.modelId).toBe('gpt-4o-mini');
    });

    it('should create Anthropic model', () => {
      const model = createModel({
        provider: 'anthropic',
        apiKey: 'test-key',
        model: 'claude-haiku-4-5-20251001',
      });
      expect(model).toBeDefined();
      expect(model.modelId).toBe('claude-haiku-4-5-20251001');
    });

    it('should create custom OpenAI-compatible model from URL', () => {
      const model = createModel({
        provider: 'https://llm.internal.corp.com/v1',
        apiKey: 'corp-key',
        model: 'llama-3-70b',
      });
      expect(model).toBeDefined();
      expect(model.modelId).toBe('llama-3-70b');
    });

    it('should create an Ollama model without an API key', () => {
      const model = createModel({ provider: LlmProvider.Ollama, apiKey: '', model: 'qwen2.5-coder:7b' });
      expect(model).toBeDefined();
      expect(model.modelId).toBe('qwen2.5-coder:7b');
    });

    it('should create an Ollama model with a custom base URL', () => {
      const model = createModel({
        provider: 'ollama',
        apiKey: '',
        model: 'llama3.1:8b',
        baseURL: 'http://gpu-box.local:11434',
      });
      expect(model).toBeDefined();
      expect(model.modelId).toBe('llama3.1:8b');
    });

    it('should throw on empty API key', () => {
      expect(() => createModel({ provider: 'openrouter', apiKey: '', model: 'test' })).toThrow('API key is required');
    });

    it('should throw on empty API key for openai and anthropic', () => {
      expect(() => createModel({ provider: 'openai', apiKey: '', model: 'gpt' })).toThrow('API key is required');
      expect(() => createModel({ provider: 'anthropic', apiKey: '', model: 'claude' })).toThrow('API key is required');
    });

    it('should throw on unknown non-URL provider', () => {
      expect(() => createModel({ provider: 'invalid', apiKey: 'key', model: 'test' })).toThrow('Unknown LLM provider');
    });

    // The default @ai-sdk/openai callable resolves to the Responses API
    // (/responses), which Ollama (older versions) and OpenRouter do not
    // implement. createModel must pin the Chat Completions endpoint instead.
    it('pins the chat-completions endpoint for OpenAI-compatible providers', () => {
      expect(createModel({ provider: LlmProvider.Ollama, apiKey: '', model: 'm' }).provider).toBe('openai.chat');
      expect(createModel({ provider: 'openrouter', apiKey: 'k', model: 'm' }).provider).toBe('openai.chat');
      expect(createModel({ provider: 'openai', apiKey: 'k', model: 'm' }).provider).toBe('openai.chat');
      expect(createModel({ provider: 'https://llm.internal.corp.com/v1', apiKey: 'k', model: 'm' }).provider).toBe(
        'openai.chat',
      );
    });
  });

  describe('normalizeOllamaBaseUrl', () => {
    it('appends /v1 when missing', () => {
      expect(normalizeOllamaBaseUrl('http://localhost:11434')).toBe('http://localhost:11434/v1');
    });

    it('leaves an existing /v1 suffix untouched', () => {
      expect(normalizeOllamaBaseUrl('http://localhost:11434/v1')).toBe('http://localhost:11434/v1');
    });

    it('tolerates a trailing slash', () => {
      expect(normalizeOllamaBaseUrl('http://localhost:11434/')).toBe('http://localhost:11434/v1');
      expect(normalizeOllamaBaseUrl('http://localhost:11434/v1/')).toBe('http://localhost:11434/v1');
    });
  });

  describe('preflightModel', () => {
    const fakeModel = {} as LanguageModel;

    it('resolves when the model responds', async () => {
      mockGenerateText.mockResolvedValueOnce({ text: 'ok' } as never);
      await expect(preflightModel(fakeModel, 'ollama (qwen2.5-coder:7b)')).resolves.toBeUndefined();
      expect(mockGenerateText).toHaveBeenCalledTimes(1);
    });

    it('throws a labelled error when the model call fails', async () => {
      mockGenerateText.mockRejectedValueOnce(new Error('ECONNREFUSED 127.0.0.1:11434'));
      await expect(preflightModel(fakeModel, 'ollama (qwen2.5-coder:7b)')).rejects.toThrow(
        /LLM preflight failed for ollama \(qwen2\.5-coder:7b\): .*ECONNREFUSED/,
      );
    });
  });
});
