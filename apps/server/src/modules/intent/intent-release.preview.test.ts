import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../database/prisma.service.js';
import { IntentReleaseService, releaseContentHash } from './intent-release.service.js';

describe('batch release preview query cost', () => {
  it('reads one snapshot and one ancestry traversal for 200 rules', async () => {
    const ids = Array.from({ length: 200 }, (_, i) => `br-${i}`);
    const items = ids.map((id) => ({
      id,
      kind: 'business_rule',
      title: id,
      statement: 'Applies',
      rationale: null,
      payload: {},
      authority: 'accepted',
      version: 1,
      sources: [],
    }));
    const tx = {
      intentItem: { findMany: vi.fn().mockResolvedValue(items) },
      intentReleaseEvent: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]) },
      $queryRaw: vi.fn().mockResolvedValue([]),
    };
    const transaction = vi.fn(async (read: (client: typeof tx) => unknown) => read(tx));
    const service = new IntentReleaseService({ $transaction: transaction } as unknown as PrismaService);
    const previews = await service.previewMany('workspace', ids);
    expect(previews.map((item) => item.itemId)).toEqual(ids);
    expect(previews.every((item) => item.headSeq === 0)).toBe(true);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(tx.intentReleaseEvent.findMany).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  });
});

describe('releaseContentHash', () => {
  const rule = {
    kind: 'business_rule',
    title: 'Weekly overtime threshold',
    statement: 'Hours above the threshold count as overtime.',
    rationale: null,
    payload: {
      condition: 'Weekly worked hours exceed the threshold',
      requiredOutcome: 'Hours above the threshold count as overtime',
      observer: 'Payroll export',
      exceptions: ['Salaried staff'],
    },
  };

  it('keeps the pre-dimensions hash for an unconditioned item', () => {
    // Captured before `appliesWhen` existed: a release preview taken before deploy must still confirm after it.
    const baseline = '2a76d0f2133db7ea093b0fc8ef4ee31455897355768d08e7815d237a80403040';
    expect(releaseContentHash(rule)).toBe(baseline);
    expect(releaseContentHash({ ...rule, appliesWhen: null })).toBe(baseline);
    expect(releaseContentHash({ ...rule, appliesWhen: [] })).toBe(baseline);
  });

  it('changes when the item carries context conditions', () => {
    expect(releaseContentHash({ ...rule, appliesWhen: [{ dimension: 'country', notIn: ['ua'] }] })).not.toBe(
      releaseContentHash(rule),
    );
  });
});
