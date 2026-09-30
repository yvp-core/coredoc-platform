/**
 * Tests for the query-time embedding client (semantic_search).
 * All HTTP is mocked via a stubbed global fetch.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { embedQueryText } from './query-embedder.js';

const ORIGINAL_OLLAMA_URL = process.env.OLLAMA_BASE_URL;
const ORIGINAL_OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;

afterEach(() => {
  vi.unstubAllGlobals();
  if (ORIGINAL_OLLAMA_URL === undefined) delete process.env.OLLAMA_BASE_URL;
  else process.env.OLLAMA_BASE_URL = ORIGINAL_OLLAMA_URL;
  if (ORIGINAL_OPENROUTER_KEY === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = ORIGINAL_OPENROUTER_KEY;
});

describe('embedQueryText — ollama', () => {
  it('POSTs {model, input} to {base}/api/embed and returns the first vector', async () => {
    delete process.env.OLLAMA_BASE_URL;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ embeddings: [[0.1, 0.2]] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const vector = await embedQueryText('hello', 'ollama', 'qwen3-embedding:4b');

    expect(vector).toEqual([0.1, 0.2]);
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:11434/api/embed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3-embedding:4b', input: 'hello' }),
      signal: expect.any(AbortSignal),
    });
  });

  it('honors OLLAMA_BASE_URL', async () => {
    process.env.OLLAMA_BASE_URL = 'http://ollama.internal:9999';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ embeddings: [[1]] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await embedQueryText('x', 'ollama', 'm');

    expect(fetchMock).toHaveBeenCalledWith('http://ollama.internal:9999/api/embed', expect.anything());
  });

  it('fails fast naming the base URL when the host is unreachable', async () => {
    delete process.env.OLLAMA_BASE_URL;
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));

    await expect(embedQueryText('x', 'ollama', 'm')).rejects.toThrow(/unreachable at http:\/\/localhost:11434/);
  });

  it('fails fast on a non-OK response, naming status and model', async () => {
    delete process.env.OLLAMA_BASE_URL;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404, text: async () => 'model not found' }));

    await expect(embedQueryText('x', 'ollama', 'missing-model')).rejects.toThrow(/HTTP 404.*missing-model/);
  });

  it('maps a request timeout to an actionable error naming the host', async () => {
    delete process.env.OLLAMA_BASE_URL;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new DOMException('The operation was aborted due to timeout', 'TimeoutError')),
    );

    await expect(embedQueryText('x', 'ollama', 'm')).rejects.toThrow(
      /did not respond within 15s at http:\/\/localhost:11434.*Ollama is running/s,
    );
  });
});

describe('embedQueryText — openrouter', () => {
  it('fails fast naming OPENROUTER_API_KEY when the key is missing', async () => {
    delete process.env.OPENROUTER_API_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(embedQueryText('x', 'openrouter', 'm')).rejects.toThrow(/OPENROUTER_API_KEY/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POSTs {model, input} to the OpenAI-compatible /embeddings endpoint with the bearer key', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-test';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ embedding: [0.3, 0.4] }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const vector = await embedQueryText('hello', 'openrouter', 'qwen/qwen3-embedding-4b');

    expect(vector).toEqual([0.3, 0.4]);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/embeddings',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer sk-test' }),
        body: JSON.stringify({ model: 'qwen/qwen3-embedding-4b', input: 'hello' }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('maps a request timeout to an actionable error naming the host', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-test';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new DOMException('The operation was aborted due to timeout', 'TimeoutError')),
    );

    await expect(embedQueryText('x', 'openrouter', 'm')).rejects.toThrow(
      /did not respond within 15s at https:\/\/openrouter\.ai\/api\/v1/,
    );
  });
});

describe('embedQueryText — unknown provider', () => {
  it('fails fast naming the unsupported provider', async () => {
    await expect(embedQueryText('x', 'huggingface', 'm')).rejects.toThrow(/Unknown embedding provider "huggingface"/);
  });
});
