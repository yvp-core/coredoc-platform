/**
 * Query-time embedding client for semantic_search.
 *
 * Minimal fetch-based client — deliberately NOT the CLI's LangChain provider
 * stack: @coredoc/mcp must not depend on @coredoc/cli (wrong dependency
 * direction), and LangChain is a heavy dependency for a single embed-one-query
 * call. Endpoints and payloads mirror what the CLI's providers ultimately hit:
 *  - ollama:     POST {OLLAMA_BASE_URL|http://localhost:11434}/api/embed
 *                body {model, input} → {embeddings: number[][]}
 *  - openrouter: POST https://openrouter.ai/api/v1/embeddings (OpenAI-compatible)
 *                body {model, input} → {data: [{embedding: number[]}]}
 *
 * Provider + model always come from the graph's stored per-node provenance
 * (embeddingProvider/embeddingModel), so the query vector is guaranteed to
 * live in the same embedding space as the stored vectors. Fails fast with the
 * missing key / unreachable host named — no silent provider fallback.
 */

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/**
 * Abort the embed request after this long — a hung provider must fail fast
 * with an actionable error, not stall the MCP tool call indefinitely.
 */
const EMBED_REQUEST_TIMEOUT_MS = 15000;

/**
 * Whether a fetch rejection came from AbortSignal.timeout (TimeoutError) or a
 * plain abort (AbortError). Checked by name, not instanceof: the runtime
 * raises a DOMException, whose prototype chain varies across Node versions.
 */
function isTimeoutError(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}

/**
 * Embed a free-text query with the given provider/model. Throws on unknown
 * provider, missing credentials, unreachable host, or an empty response.
 */
export async function embedQueryText(text: string, provider: string, model: string): Promise<number[]> {
  switch (provider) {
    case 'ollama':
      return embedWithOllama(text, model);
    case 'openrouter':
      return embedWithOpenRouter(text, model);
    default:
      throw new Error(
        `Unknown embedding provider "${provider}" stored in the graph (supported: ollama, openrouter). ` +
          'Re-run `coredoc embed` with a supported provider and re-push.',
      );
  }
}

async function embedWithOllama(text: string, model: string): Promise<number[]> {
  const baseUrl = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: text }),
      signal: AbortSignal.timeout(EMBED_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new Error(
        `Ollama did not respond within ${EMBED_REQUEST_TIMEOUT_MS / 1000}s at ${baseUrl}. ` +
          'Check that Ollama is running and responsive, or point OLLAMA_BASE_URL at a healthy instance.',
      );
    }
    throw new Error(
      `Ollama is unreachable at ${baseUrl} (${error instanceof Error ? error.message : String(error)}). ` +
        'Start Ollama or point OLLAMA_BASE_URL at a running instance.',
    );
  }
  if (!response.ok) {
    throw new Error(
      `Ollama embed request failed (HTTP ${response.status}) for model "${model}": ${await safeBody(response)}`,
    );
  }
  const json = (await response.json()) as { embeddings?: number[][] };
  const vector = json.embeddings?.[0];
  if (!vector || vector.length === 0) {
    throw new Error(`Ollama returned no embedding for model "${model}".`);
  }
  return vector;
}

async function embedWithOpenRouter(text: string, model: string): Promise<number[]> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error(
      'OPENROUTER_API_KEY is not set — required to embed the query with the stored openrouter model. ' +
        'Export it in the MCP server environment.',
    );
  }
  let response: Response;
  try {
    response = await fetch(`${OPENROUTER_BASE_URL}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        // Attribution headers, matching the CLI's OpenRouter configuration.
        'HTTP-Referer': 'https://github.com/coredoc',
        'X-Title': 'coredoc',
      },
      body: JSON.stringify({ model, input: text }),
      signal: AbortSignal.timeout(EMBED_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new Error(
        `OpenRouter did not respond within ${EMBED_REQUEST_TIMEOUT_MS / 1000}s at ${OPENROUTER_BASE_URL}. ` +
          'Check network connectivity and OpenRouter status, then retry.',
      );
    }
    throw new Error(
      `OpenRouter is unreachable at ${OPENROUTER_BASE_URL} (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `OpenRouter embed request failed (HTTP ${response.status}) for model "${model}": ${await safeBody(response)}`,
    );
  }
  const json = (await response.json()) as { data?: Array<{ embedding?: number[] }> };
  const vector = json.data?.[0]?.embedding;
  if (!vector || vector.length === 0) {
    throw new Error(`OpenRouter returned no embedding for model "${model}".`);
  }
  return vector;
}

/** Best-effort error-body excerpt for failed requests (diagnostics only). */
async function safeBody(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 200);
  } catch {
    return '<unreadable body>';
  }
}
