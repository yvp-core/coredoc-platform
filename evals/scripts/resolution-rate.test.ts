import { createClient } from '@libsql/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BASELINE_RESOLVABLE_RATE,
  EVENT_PROTOCOLS,
  INFRA_NOISE_PROTOCOLS,
  PROJECTED_RESOLVABLE_RATE,
  REGRESSION_GUARD_RATE,
  measureResolution,
  type ResolutionSnapshot,
} from './resolution-rate.js';

// Minimal in-memory libsql graph: just the columns measureResolution reads.
async function seed(rows: { protocol: string; resolved: boolean; count: number }[], resolvesToEdges: number) {
  const client = createClient({ url: ':memory:' });
  await client.execute('CREATE TABLE nodes (id TEXT PRIMARY KEY, type TEXT, properties TEXT)');
  await client.execute('CREATE TABLE edges (id TEXT PRIMARY KEY, type TEXT, created_by TEXT)');
  let n = 0;
  for (const r of rows) {
    for (let i = 0; i < r.count; i++) {
      const props: Record<string, unknown> = { protocol: r.protocol };
      if (r.resolved) props.resolvedTargetId = `ep:${n}`;
      await client.execute({
        sql: 'INSERT INTO nodes (id, type, properties) VALUES (?, ?, ?)',
        args: [`ec:${n++}`, 'external_call', JSON.stringify(props)],
      });
    }
  }
  for (let i = 0; i < resolvesToEdges; i++) {
    await client.execute({
      sql: 'INSERT INTO edges (id, type, created_by) VALUES (?, ?, ?)',
      args: [`resolve:${i}`, 'RESOLVES_TO', 'ai'],
    });
  }
  return client;
}

describe('resolution-rate constants', () => {
  it('orders baseline < guard < projection', () => {
    expect(BASELINE_RESOLVABLE_RATE).toBeLessThan(REGRESSION_GUARD_RATE);
    expect(REGRESSION_GUARD_RATE).toBeLessThan(PROJECTED_RESOLVABLE_RATE);
  });

  it('excludes intra-process noise from the resolvable denominator', () => {
    for (const p of ['internal', 'ipc', 'subprocess', 'bolt', 'temporal']) {
      expect(INFRA_NOISE_PROTOCOLS.has(p)).toBe(true);
    }
    expect(INFRA_NOISE_PROTOCOLS.has('http')).toBe(false);
    expect(INFRA_NOISE_PROTOCOLS.has('kafka')).toBe(false);
  });

  it('treats kafka as an event protocol', () => {
    expect(EVENT_PROTOCOLS.has('kafka')).toBe(true);
    expect(EVENT_PROTOCOLS.has('http')).toBe(false);
  });
});

describe('measureResolution', () => {
  let client: Awaited<ReturnType<typeof seed>>;
  afterEach(() => client?.close());

  it('reproduces the pre-redesign baseline distribution shape', async () => {
    client = await seed(
      [
        { protocol: 'http', resolved: true, count: 1081 },
        { protocol: 'http', resolved: false, count: 1135 },
        { protocol: 'kafka', resolved: false, count: 76 },
        { protocol: 'internal', resolved: true, count: 243 },
        { protocol: 'internal', resolved: false, count: 445 },
        { protocol: 'ipc', resolved: false, count: 151 },
        { protocol: 'subprocess', resolved: false, count: 14 },
        { protocol: 'temporal', resolved: false, count: 11 },
        { protocol: 'bolt', resolved: false, count: 19 },
      ],
      1306,
    );
    const snap = await measureResolution(client);

    expect(snap.totalCalls).toBe(3175);
    expect(snap.resolvesToEdges).toBe(1306);
    // Resolvable denominator excludes internal/ipc/subprocess/temporal/bolt.
    // Resolvable = http(1081+1135) + kafka(0+76) = 2292; resolved = 1081.
    expect(snap.resolvableTotal).toBe(2292);
    expect(snap.resolvableResolved).toBe(1081);
    expect(snap.resolvableRate).toBeCloseTo(1081 / 2292, 4);
    // Events are 0 at baseline — this is the green-field zero the redesign fixes.
    expect(snap.eventsResolved).toBe(0);
    // Per-protocol breakdown is sorted and complete.
    const http = snap.byProtocol.find((r) => r.protocol === 'http');
    expect(http).toEqual({ protocol: 'http', resolved: 1081, unresolved: 1135, total: 2216 });
  });

  it('post-redesign: events resolve and rate climbs', async () => {
    client = await seed(
      [
        { protocol: 'http', resolved: true, count: 1313 }, // +232 recall gap closed
        { protocol: 'http', resolved: false, count: 903 },
        { protocol: 'kafka', resolved: true, count: 60 }, // green-field now resolving
        { protocol: 'kafka', resolved: false, count: 16 },
        { protocol: 'internal', resolved: false, count: 445 },
      ],
      1633,
    );
    const snap = await measureResolution(client);
    expect(snap.eventsResolved).toBe(60);
    // Resolvable = http(2216) + kafka(76) = 2292; resolved = 1313 + 60 = 1373.
    expect(snap.resolvableRate).toBeCloseTo(1373 / 2292, 4);
    // Rate climbed past the pre-redesign measured baseline (~0.47 in the
    // synthetic baseline test above); REGRESSION_GUARD_RATE is the live-DB bar.
    expect(snap.resolvableRate).toBeGreaterThan(BASELINE_RESOLVABLE_RATE - 0.2);
  });

  it('treats a protocol-less external_call as unresolvable noise (excluded)', async () => {
    client = await seed([{ protocol: '', resolved: false, count: 5 }], 0);
    // empty-string protocol falls through INFRA filter as unknown -> still not http/event
    const snap = await measureResolution(client);
    expect(snap.resolvableTotal).toBe(0);
    expect(snap.resolvableRate).toBe(0);
  });
});
