import { MAX_PHASE_OUTPUT_TOKENS, ReviewError, type ReviewRequest } from './contracts.js';
import { z } from 'zod';

/** OpenRouter `provider` routing object pinned to declared per-token price ceilings. */
export function openrouterProvider(inputPrice: number, outputPrice: number) {
  return {
    // Fallbacks stay under the same price ceiling and parameter requirements; without them one
    // rate-limited endpoint (Relace 429 on 90k-token prompts) ends the run. No `sort`/`order`,
    // because either disables OpenRouter sticky routing and the prompt cache lives per provider
    // endpoint; `max_price` remains the ceiling.
    allow_fallbacks: true,
    require_parameters: true,
    max_price: { prompt: inputPrice, completion: outputPrice, request: 0 },
  };
}

/** Free (unbilled) transient statuses worth a bounded retry; anything else is final. */
export const TRANSIENT_STATUSES = new Set([429, 502, 503, 504]);
/**
 * Growing back-off ladder for an unbilled transient refusal. Token-per-minute limits reset on
 * minute boundaries (Luna Pro counts ~380k prompt tokens per call, so three calls a minute already
 * trip them), and an upstream rate limit can outlast several such windows.
 */
const TRANSIENT_DELAYS_MS = [15_000, 30_000, 60_000, 90_000, 120_000];
/** Total time one call may spend waiting out transient refusals before it gives up. */
const MAX_TRANSIENT_WAIT_MS = 300_000;

export interface TransientRetry {
  /** The back-off ladder: one retry per entry the wait budget and the run deadline still allow. */
  delaysMs?: number[];
  maxTransientWaitMs?: number;
  /** Absolute epoch ms this run must not wait past (the caller's `maxSeconds` deadline). */
  deadline?: () => number | undefined;
  /** The run's cancellation; the SDK also passes it per request, this is the explicit fallback. */
  signal?: AbortSignal;
}

/** Resolves true when `signal` aborted before the delay elapsed. */
function sleep(delayMs: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(true);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(false);
    }, delayMs);
    function onAbort() {
      clearTimeout(timer);
      resolve(true);
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Per-run reservation guard for text-only OpenRouter requests. No prompts or credentials are retained. */
export function openrouterBudget(
  model: ReviewRequest['model'],
  fetcher: typeof fetch = fetch,
  retry: TransientRetry = {},
) {
  const {
    delaysMs = TRANSIENT_DELAYS_MS,
    maxTransientWaitMs = MAX_TRANSIENT_WAIT_MS,
    deadline = () => undefined,
    signal,
  } = retry;
  const { maxUsd, inputUsdPerMillion: inputPrice, outputUsdPerMillion: outputPrice } = model;
  if (maxUsd === undefined || inputPrice === undefined || outputPrice === undefined)
    throw new ReviewError('OPENROUTER_PRICES_REQUIRED');
  // `reservedUsd` is the sum of the open reservations: several lens calls may be in flight at once,
  // and each one is bounded before it is sent. An unsettled charge still latches `uncertain` and
  // refuses every later call, because the run can no longer know what it has spent.
  const usage = { actualUsd: 0, reservedUsd: 0, calls: 0, uncertain: false };
  let lastProvider: string | undefined;
  const guarded: typeof fetch = async (input, init) => {
    if (usage.uncertain) throw new ReviewError('OPENROUTER_UNSETTLED_CALL');
    const url = input instanceof Request ? input.url : String(input);
    if (
      url !== 'https://openrouter.ai/api/v1/chat/completions' ||
      init?.method !== 'POST' ||
      typeof init.body !== 'string'
    )
      throw new ReviewError('OPENROUTER_REQUEST_DENIED');
    const body = JSON.parse(init.body);
    const output = body.max_completion_tokens ?? body.max_tokens;
    if (
      body.model !== model.id ||
      body.stream ||
      !Array.isArray(body.messages) ||
      !Number.isSafeInteger(output) ||
      output < 1 ||
      output > MAX_PHASE_OUTPUT_TOKENS
    )
      throw new ReviewError('OPENROUTER_REQUEST_DENIED');
    // The price ceiling is a request semantic owned by the caller (command.ts); this guard only
    // validates that the declared prices were not bypassed or altered before transmission.
    const expectedPrice = openrouterProvider(inputPrice, outputPrice).max_price;
    if (
      body.provider?.max_price?.prompt !== expectedPrice.prompt ||
      body.provider?.max_price?.completion !== expectedPrice.completion ||
      body.provider?.max_price?.request !== expectedPrice.request
    )
      throw new ReviewError('OPENROUTER_REQUEST_DENIED');
    const serialized = JSON.stringify(body);
    // Conservative text-token reservation, including framing headroom. If the
    // provider omits accounting, refuse all subsequent calls.
    const reserve = ((Buffer.byteLength(serialized) + 8192) * inputPrice + output * outputPrice) / 1_000_000;
    if (usage.actualUsd + usage.reservedUsd + reserve > maxUsd) throw new ReviewError('OPENROUTER_PRECALL_BUDGET');
    usage.reservedUsd += reserve;
    usage.calls++;
    try {
      // OpenRouter reports provider failures either as a non-2xx status or as HTTP 200 with an
      // `error` object whose `code` mirrors the status; neither is billed.
      const send = async () => {
        const response = await fetcher(url, { ...init, body: serialized, redirect: 'error' });
        const body: unknown = await response
          .clone()
          .json()
          .catch(() => undefined);
        const error = (body as { error?: { code?: unknown } } | undefined)?.error;
        const failure = !response.ok
          ? response.status
          : error
            ? typeof error.code === 'number'
              ? error.code
              : 500
            : undefined;
        return { response, body, failure };
      };
      let sent = await send();
      // A transient refusal costs only the wait; the request is byte-identical, so the
      // reservation above still bounds the eventual charge. Waiting minutes is cheaper than
      // losing everything the run has already paid for, as long as it fits the run's clock.
      let waited = 0;
      for (const base of delaysMs) {
        if (sent.failure === undefined || !TRANSIENT_STATUSES.has(sent.failure)) break;
        // ±25 % jitter so parallel lenses that tripped the same limit do not retry in lockstep.
        const delay = Math.round(base * (0.75 + Math.random() * 0.5));
        const stopAt = deadline();
        if (waited + delay > maxTransientWaitMs) break;
        if (stopAt !== undefined && Date.now() + delay >= stopAt) break;
        // Cancellation (SIGTERM, the run timeout) ends the wait at once; the last refusal was
        // unbilled, so it is the honest result and nothing becomes uncertain.
        if (await sleep(delay, init.signal ?? signal)) break;
        waited += delay;
        sent = await send();
      }
      // A non-2xx or error-body reply is never billed, so it settles the reservation without doubt.
      if (sent.failure !== undefined) throw new ReviewError(`OPENROUTER_HTTP_${sent.failure}`);
      const parsed = z.object({ usage: z.object({ cost: z.number().nonnegative() }) }).safeParse(sent.body);
      if (!parsed.success) {
        // Keys only: the body may carry model text quoting source.
        const keys = sent.body && typeof sent.body === 'object' ? Object.keys(sent.body).join(',') : typeof sent.body;
        console.log(`OpenRouter accounting missing: keys=${keys}`);
        // A 2xx reply with no accounting may have been billed: refuse every later call.
        usage.uncertain = true;
        throw new ReviewError('OPENROUTER_COST_UNKNOWN');
      }
      const json = parsed.data;
      // A slug only, logged on change, so a run that bounces between endpoints (and so misses its
      // prompt cache) is visible in CI logs.
      const provider = (sent.body as { provider?: unknown }).provider;
      if (typeof provider === 'string' && provider !== lastProvider) {
        console.log(`OpenRouter provider: ${provider}`);
        lastProvider = provider;
      }
      const response = sent.response;
      // Settled charges are recorded as billed, even above the reservation: reasoning models
      // (Luna Pro, measured) ignore max_tokens for their reasoning tokens, so a per-call overrun
      // cannot be refused client-side. The pre-call check above still stops the run once the
      // settled total approaches maxUsd, which bounds the whole run by maxUsd plus one call.
      usage.actualUsd += json.usage.cost;
      return response;
    } catch (error) {
      if (error instanceof ReviewError) throw error;
      // The transport failed after the request left: the call may have been billed.
      usage.uncertain = true;
      // Provider exceptions can contain request headers and source text.
      throw new ReviewError('OPENROUTER_CALL_UNSETTLED');
    } finally {
      // Open reservations sum to zero once all settle; clamp the float residue so the report reads 0.
      usage.reservedUsd = Math.max(0, usage.reservedUsd - reserve);
    }
  };
  return { fetch: guarded, usage };
}
