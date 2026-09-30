import { describe, expect, it } from 'vitest';
import { foldIntentReleases, type ReleaseEvent } from './intent-release.fold.js';
import { releaseOrderingConflict } from './intent-release.service.js';

function event(seq: number, kind: ReleaseEvent['kind'], data: ReleaseEvent['data']): ReleaseEvent {
  return { seq, kind, data, recordedAt: '2026-09-05T00:00:00.000Z', recordedBy: 'maintainer' };
}

describe('recorded intent effectivity', () => {
  it('refuses an unknown persisted event kind instead of activating a plan', () => {
    expect(() => foldIntentReleases([event(1, 'unexpected' as ReleaseEvent['kind'], { itemId: 'a' })])).toThrow(
      'Unsupported intent release event kind',
    );
  });
  it('replaces the entire ancestry while preserving independent rules and never delivering intermediates', () => {
    const state = foldIntentReleases([
      event(1, 'baseline', { deliveredRef: 'r1', included: ['a', 'x'], retired: [], ancestors: [] }),
      event(2, 'plan', { itemId: 'b' }),
      event(3, 'plan', { itemId: 'c' }),
      event(4, 'release', { deliveredRef: 'r2', included: ['c'], retired: [], ancestors: ['a', 'b'] }),
    ]);
    expect(state.effectiveIds).toEqual(['c', 'x']);
    expect(state.effectivity('b')).toBe('not_effective');
    expect(state.effectivity('unrecorded')).toBe('unknown');
  });

  it('rolls back delivery without discarding later independent plan decisions, then rolls back again', () => {
    const events = [
      event(1, 'release', { deliveredRef: 'r1', included: ['a'], retired: [], ancestors: [] }),
      event(2, 'plan', { itemId: 'b' }),
      event(3, 'plan', { itemId: 'x' }),
      event(4, 'release', { deliveredRef: 'r2', included: ['b'], retired: [], ancestors: ['a'] }),
      event(5, 'withdraw', { itemId: 'x' }),
      event(6, 'rollback', { releaseSeq: 4 }),
    ];
    const restored = foldIntentReleases(events);
    expect(restored.headSeq).toBe(6);
    expect(restored.currentRelease?.seq).toBe(1);
    expect(restored.effectivity('a')).toBe('effective');
    expect(restored.effectivity('b')).toBe('planned');
    expect(restored.effectivity('x')).toBe('withdrawn');
    const empty = foldIntentReleases([...events, event(7, 'rollback', { releaseSeq: 1 })]);
    expect(empty.effectivity('a')).toBe('unknown');
    expect(empty.currentRelease).toBeNull();
  });

  it('does not invent a plan for baseline content, and restores a withdrawn plan after rollback', () => {
    const state = foldIntentReleases([
      event(1, 'plan', { itemId: 'b' }),
      event(2, 'withdraw', { itemId: 'b' }),
      event(3, 'release', { deliveredRef: 'r1', included: ['a', 'b'], retired: [], ancestors: [] }),
      event(4, 'rollback', { releaseSeq: 3 }),
    ]);
    expect(state.effectivity('a')).toBe('unknown');
    expect(state.effectivity('b')).toBe('withdrawn');
    expect(foldIntentReleases([...state.events, event(5, 'reinstate', { itemId: 'b' })]).effectivity('b')).toBe(
      'planned',
    );
  });
  it('keeps the newest ordering token per (repository, item), skipping rolled-back and human records', () => {
    const t = (h: number) => `2026-09-20T${String(h).padStart(2, '0')}:00:00.000Z`;
    const state = foldIntentReleases([
      event(1, 'release', {
        deliveredRef: 'a1',
        included: ['a'],
        retired: ['r'],
        repoKey: 'repo-a',
        orderingToken: t(9),
      }),
      event(2, 'release', { deliveredRef: 'b1', included: ['a'], repoKey: 'repo-b', orderingToken: t(11) }),
      event(3, 'release', {
        deliveredRef: 'a2',
        included: ['c'],
        ancestors: ['p'],
        repoKey: 'repo-a',
        orderingToken: t(10),
      }),
      event(4, 'release', { deliveredRef: 'a0', included: ['a'], repoKey: 'repo-a', orderingToken: t(8) }),
      event(5, 'release', { deliveredRef: 'manual', included: ['d'] }),
      event(6, 'release', { deliveredRef: 'a3', included: ['e'], repoKey: 'repo-a', orderingToken: t(12) }),
      event(7, 'rollback', { releaseSeq: 6 }),
    ]);
    expect(state.latestTokenOf('repo-a', 'a')).toBe(t(9));
    expect(state.latestTokenOf('repo-a', 'r')).toBe(t(9));
    expect(state.latestTokenOf('repo-a', 'p')).toBe(t(10));
    expect(state.latestTokenOf('repo-b', 'a')).toBe(t(11));
    expect(state.latestTokenOf('repo-a', 'd')).toBeUndefined();
    expect(state.latestTokenOf('repo-a', 'e')).toBeUndefined();
  });
  it('orders per item: a late PR on a disjoint item passes, one on a shared item is refused (AC-5)', () => {
    const y = event(1, 'release', {
      deliveredRef: 'y',
      included: ['item-y'],
      repoKey: 'repo',
      orderingToken: '2026-09-20T12:00:00.000Z',
    });
    const state = foldIntentReleases([y]);
    const earlier = '2026-09-20T11:00:00.000Z';
    expect(releaseOrderingConflict(state, 'repo', ['item-x'], earlier)).toBeNull();
    expect(releaseOrderingConflict(state, 'repo', ['item-x', 'item-y'], earlier)).toEqual({
      itemId: 'item-y',
      token: '2026-09-20T12:00:00.000Z',
    });
    // One deploy ships several PRs under the same token.
    expect(releaseOrderingConflict(state, 'repo', ['item-y'], '2026-09-20T12:00:00.000Z')).toBeNull();
    expect(releaseOrderingConflict(state, 'other-repo', ['item-y'], earlier)).toBeNull();
    const withX = foldIntentReleases([
      y,
      event(2, 'release', { deliveredRef: 'x', included: ['item-x'], repoKey: 'repo', orderingToken: earlier }),
    ]);
    expect(withX.effectiveIds).toEqual(['item-x', 'item-y']);
  });
  it('lists every unrolled delivery of an item per repository; effective from the first', () => {
    const pr = (repoKey: string, number: number) => ({ repoKey, number });
    const first = event(1, 'release', {
      deliveredRef: 'a1',
      included: ['x'],
      repoKey: 'repo-a',
      pr: pr('repo-a', 1),
      orderingToken: 'T1',
    });
    expect(foldIntentReleases([first]).effectivity('x')).toBe('effective');
    const state = foldIntentReleases([
      first,
      event(2, 'release', {
        deliveredRef: 'b1',
        included: ['x'],
        repoKey: 'repo-b',
        pr: pr('repo-b', 7),
        orderingToken: 'T2',
      }),
      event(3, 'release', {
        deliveredRef: 'b2',
        included: ['x'],
        repoKey: 'repo-b',
        pr: pr('repo-b', 8),
        orderingToken: 'T3',
      }),
      event(4, 'rollback', { releaseSeq: 3 }),
    ]);
    expect(state.effectivity('x')).toBe('effective');
    expect(state.deliveriesOf('x')).toEqual([
      { seq: 1, deliveredRef: 'a1', repoKey: 'repo-a', pr: pr('repo-a', 1), orderingToken: 'T1' },
      { seq: 2, deliveredRef: 'b1', repoKey: 'repo-b', pr: pr('repo-b', 7), orderingToken: 'T2' },
    ]);
    expect(state.deliveriesOf('unrecorded')).toEqual([]);
  });
});
