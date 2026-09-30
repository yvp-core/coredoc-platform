import { describe, expect, it, vi } from 'vitest';
import { MAX_PHASE_OUTPUT_TOKENS } from './contracts.js';
import { openrouterBudget, openrouterProvider } from './openrouter-budget.js';

const model = {
  provider: 'openrouter',
  id: 'google/gemini-3.8-flash',
  inputUsdPerMillion: 0.75,
  outputUsdPerMillion: 3.75,
  maxUsd: 1,
};
const url = 'https://openrouter.ai/api/v1/chat/completions';
const request = {
  method: 'POST',
  body: JSON.stringify({
    model: model.id,
    messages: [{ role: 'user', content: 'Review' }],
    max_tokens: MAX_PHASE_OUTPUT_TOKENS,
    provider: openrouterProvider(model.inputUsdPerMillion, model.outputUsdPerMillion),
  }),
};
const reply = (cost = 0.01) => Response.json({ usage: { cost, prompt_tokens: 50, completion_tokens: 20 } });

describe('OpenRouter pre-call budget', () => {
  it('pins the model price ceiling and records actual settled cost', async () => {
    const fetcher = vi.fn(async () => reply());
    const guard = openrouterBudget(model, fetcher);
    await guard.fetch(url, request);
    expect(guard.usage).toEqual({ actualUsd: 0.01, reservedUsd: 0, calls: 1, uncertain: false });
    const init = (fetcher.mock.calls as unknown as Array<[string, RequestInit]>)[0]![1];
    expect(JSON.parse(init.body as string).provider).toMatchObject({
      allow_fallbacks: true,
      max_price: { prompt: 0.75, completion: 3.75, request: 0 },
    });
    expect(init.redirect).toBe('error');
  });
  it('logs the serving provider once per change, so endpoint bouncing is visible', async () => {
    const providers = ['OpenAI', 'Azure', 'Azure'];
    const fetcher = vi.fn(async () => Response.json({ usage: { cost: 0.01 }, provider: providers.shift() }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const guard = openrouterBudget(model, fetcher);
    await guard.fetch(url, request);
    await guard.fetch(url, request);
    expect(log.mock.calls.filter(([line]) => String(line).startsWith('OpenRouter provider:'))).toEqual([
      ['OpenRouter provider: OpenAI'],
      ['OpenRouter provider: Azure'],
    ]);
    log.mockClear();
    await guard.fetch(url, request);
    expect(log.mock.calls.filter(([line]) => String(line).startsWith('OpenRouter provider:'))).toEqual([]);
    log.mockRestore();
  });
  it('denies a request whose provider price ceiling does not match the declared prices', async () => {
    const fetcher = vi.fn(async () => reply());
    const guard = openrouterBudget(model, fetcher);
    const tampered = JSON.stringify({
      ...JSON.parse(request.body),
      provider: openrouterProvider(model.inputUsdPerMillion, 999),
    });
    await expect(guard.fetch(url, { ...request, body: tampered })).rejects.toThrow('OPENROUTER_REQUEST_DENIED');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('refuses a request before charging when the reservation cannot fit', async () => {
    const fetcher = vi.fn(async () => reply());
    const guard = openrouterBudget({ ...model, maxUsd: 0.001 }, fetcher);
    await expect(guard.fetch(url, request)).rejects.toThrow('OPENROUTER_PRECALL_BUDGET');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('settles a charge above its reservation and lets the pre-call check stop the run', async () => {
    const fetcher = vi.fn(async () => reply(0.9));
    const guard = openrouterBudget(model, fetcher);
    expect((await guard.fetch(url, request)).ok).toBe(true);
    expect(guard.usage).toMatchObject({ actualUsd: 0.9, reservedUsd: 0, uncertain: false });
    await expect(guard.fetch(url, request)).rejects.toThrow('OPENROUTER_PRECALL_BUDGET');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['missing', 'OPENROUTER_COST_UNKNOWN'],
    ['exception', 'OPENROUTER_CALL_UNSETTLED'],
  ] as const)('blocks further calls after uncertain accounting: %s', async (kind, code) => {
    const fetcher = vi.fn(async () => {
      if (kind === 'exception') throw new Error('sensitive provider response');
      return Response.json({});
    });
    const guard = openrouterBudget(model, fetcher);
    await expect(guard.fetch(url, request)).rejects.toThrow(code);
    await expect(guard.fetch(url, request)).rejects.toThrow('OPENROUTER_UNSETTLED_CALL');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(guard.usage.uncertain).toBe(true);
  });
  it('does not latch uncertain accounting on a non-2xx response, since OpenRouter never bills it', async () => {
    const fetcher = vi.fn(async () => new Response('rate limited', { status: 429 }));
    const guard = openrouterBudget(model, fetcher, { delaysMs: [] });
    await expect(guard.fetch(url, request)).rejects.toThrow('OPENROUTER_HTTP_429');
    expect(guard.usage.uncertain).toBe(false);
    // A later call is not blocked as an unsettled call: the guard reaches the fetcher again.
    await expect(guard.fetch(url, request)).rejects.toThrow('OPENROUTER_HTTP_429');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('retries a transient refusal a bounded number of times and settles the eventual reply once', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockResolvedValueOnce(new Response('bad gateway', { status: 502 }))
      .mockResolvedValueOnce(reply(0.01));
    const guard = openrouterBudget(model, fetcher, { delaysMs: [0, 0] });
    expect((await guard.fetch(url, request)).ok).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(guard.usage).toMatchObject({ calls: 1, actualUsd: 0.01, uncertain: false });
    const exhausted = vi.fn(async () => new Response('rate limited', { status: 429 }));
    const capped = openrouterBudget(model, exhausted, { delaysMs: [0] });
    await expect(capped.fetch(url, request)).rejects.toThrow('OPENROUTER_HTTP_429');
    expect(exhausted).toHaveBeenCalledTimes(2);
    const fatal = vi.fn(async () => new Response('forbidden', { status: 403 }));
    await expect(openrouterBudget(model, fatal, { delaysMs: [0, 0] }).fetch(url, request)).rejects.toThrow(
      'OPENROUTER_HTTP_403',
    );
    expect(fatal).toHaveBeenCalledTimes(1);
  });
  it('keeps retrying past three attempts while the wait budget allows, then stops', async () => {
    vi.useFakeTimers();
    // No jitter, so the ladder is exactly 15 + 30 + 60 + 90 + 120 s here.
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      const fetcher = vi.fn(async () => new Response('rate limited', { status: 429 }));
      const guard = openrouterBudget(model, fetcher);
      const rejected = expect(guard.fetch(url, request)).rejects.toThrow('OPENROUTER_HTTP_429');
      await vi.runAllTimersAsync();
      await rejected;
      // Four waits (195 s) fit the five-minute budget; the fifth rung (315 s) does not.
      expect(fetcher).toHaveBeenCalledTimes(5);
      expect(guard.usage).toMatchObject({ calls: 1, actualUsd: 0, uncertain: false });
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });
  it('does not start a wait that would run past the run deadline', async () => {
    const fetcher = vi.fn(async () => new Response('rate limited', { status: 429 }));
    const guard = openrouterBudget(model, fetcher, { deadline: () => Date.now() - 1 });
    await expect(guard.fetch(url, request)).rejects.toThrow('OPENROUTER_HTTP_429');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('ends a back-off wait as soon as the run is cancelled', async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn(async () => new Response('rate limited', { status: 429 }));
      const guard = openrouterBudget(model, fetcher);
      const ctrl = new AbortController();
      const rejected = expect(guard.fetch(url, { ...request, signal: ctrl.signal })).rejects.toThrow(
        'OPENROUTER_HTTP_429',
      );
      await vi.advanceTimersByTimeAsync(1_000);
      ctrl.abort();
      await rejected;
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(guard.usage).toMatchObject({ calls: 1, actualUsd: 0, reservedUsd: 0, uncertain: false });
    } finally {
      vi.useRealTimers();
    }
  });
  it('honours the run signal given to the guard when the request carries none', async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn(async () => new Response('rate limited', { status: 429 }));
      const ctrl = new AbortController();
      const guard = openrouterBudget(model, fetcher, { signal: ctrl.signal });
      const rejected = expect(guard.fetch(url, request)).rejects.toThrow('OPENROUTER_HTTP_429');
      await vi.advanceTimersByTimeAsync(1_000);
      ctrl.abort();
      await rejected;
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
  it('jitters each back-off within a quarter of its rung', async () => {
    vi.useFakeTimers();
    try {
      const at: number[] = [];
      const fetcher = vi.fn(async () => {
        at.push(Date.now());
        return new Response('rate limited', { status: 429 });
      });
      const guard = openrouterBudget(model, fetcher, { delaysMs: [1_000, 2_000] });
      const rejected = expect(guard.fetch(url, request)).rejects.toThrow('OPENROUTER_HTTP_429');
      await vi.runAllTimersAsync();
      await rejected;
      const waits = at.slice(1).map((sent, i) => sent - at[i]!);
      expect(waits).toHaveLength(2);
      expect(waits[0]).toBeGreaterThanOrEqual(750);
      expect(waits[0]).toBeLessThanOrEqual(1_250);
      expect(waits[1]).toBeGreaterThanOrEqual(1_500);
      expect(waits[1]).toBeLessThanOrEqual(2_500);
    } finally {
      vi.useRealTimers();
    }
  });
  it('treats an HTTP 200 body carrying an error object as the unbilled failure it is', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ error: { code: 502, message: 'Provider returned error' } }))
      .mockResolvedValueOnce(reply(0.01));
    const guard = openrouterBudget(model, fetcher, { delaysMs: [0] });
    expect((await guard.fetch(url, request)).ok).toBe(true);
    expect(guard.usage).toMatchObject({ calls: 1, actualUsd: 0.01, uncertain: false });
    const fatal = vi.fn(async () => Response.json({ error: { code: 400, message: 'bad request' } }));
    const capped = openrouterBudget(model, fatal, { delaysMs: [0] });
    await expect(capped.fetch(url, request)).rejects.toThrow('OPENROUTER_HTTP_400');
    expect(capped.usage.uncertain).toBe(false);
    expect(fatal).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['in order', false],
    ['out of order', true],
  ] as const)('settles two calls that are in flight together (%s)', async (_label, reverse) => {
    const gates: Array<() => void> = [];
    const fetcher = vi.fn(async () => {
      await new Promise<void>((resolve) => gates.push(resolve));
      return reply(0.01);
    });
    const guard = openrouterBudget(model, fetcher);
    const first = guard.fetch(url, request);
    const second = guard.fetch(url, request);
    // Both requests left before either settled: the guard no longer serializes calls.
    await vi.waitFor(() => expect(gates).toHaveLength(2));
    expect(guard.usage.calls).toBe(2);
    // Two open reservations are both counted while nothing has settled yet: about $0.19 each.
    expect(guard.usage.reservedUsd).toBeGreaterThan(0.3);
    expect(guard.usage.reservedUsd).toBeLessThan(0.4);
    for (const release of reverse ? [...gates].reverse() : gates) release();
    expect((await Promise.all([first, second])).every((r) => r.ok)).toBe(true);
    expect(guard.usage).toMatchObject({ actualUsd: 0.02, reservedUsd: 0, calls: 2, uncertain: false });
  });
  it('refuses a further in-flight call once the open reservations would exceed the budget', async () => {
    const gates: Array<() => void> = [];
    const fetcher = vi.fn(async () => {
      // Only the first two calls are held open; a later call settles straight away.
      if (gates.length < 2) await new Promise<void>((resolve) => gates.push(resolve));
      return reply(0.01);
    });
    // Each reservation is about $0.19: two fit under $0.5, a third does not.
    const guard = openrouterBudget({ ...model, maxUsd: 0.5 }, fetcher);
    const inFlight = [guard.fetch(url, request), guard.fetch(url, request)];
    await vi.waitFor(() => expect(gates).toHaveLength(2));
    await expect(guard.fetch(url, request)).rejects.toThrow('OPENROUTER_PRECALL_BUDGET');
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const release of gates) release();
    await Promise.all(inFlight);
    // With both charges settled the freed reservations let the next call through.
    expect(guard.usage).toMatchObject({ actualUsd: 0.02, reservedUsd: 0 });
    expect((await guard.fetch(url, request)).ok).toBe(true);
  });
  it('refuses alternate endpoints and model substitution before transmitting the key', async () => {
    const fetcher = vi.fn(async () => reply());
    const guard = openrouterBudget(model, fetcher);
    await expect(guard.fetch('https://untrusted.test', request)).rejects.toThrow('OPENROUTER_REQUEST_DENIED');
    await expect(guard.fetch(url, { ...request, body: request.body.replace(model.id, 'other/model') })).rejects.toThrow(
      'OPENROUTER_REQUEST_DENIED',
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
});
