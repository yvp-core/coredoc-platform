import { afterEach, expect, it, vi } from 'vitest';
import { intentItemsQueryOptions, intentSourceOptions, selectMatchingIntentItems } from './intent-api';

afterEach(() => {
  vi.unstubAllGlobals();
});
it('selects the complete matching set with the same production and source filters', async () => {
  const intentListItems = vi
    .fn()
    .mockResolvedValue({ success: true, data: { items: [{ id: 'br-a' }], nextCursor: null } });
  vi.stubGlobal('window', { electronAPI: { intentListItems } });
  const query = {
    production: 'true' as const,
    effectivity: 'planned' as const,
    sourceRef: 'spec/uploads',
    sourceKind: 'spec',
    search: 'size',
    authorities: 'accepted',
  };
  expect(await selectMatchingIntentItems('ws', query)).toEqual([{ id: 'br-a' }]);
  expect(intentListItems).toHaveBeenCalledWith('ws', { ...query, limit: 200 });
});
it('refuses to call a partial page all matching rules', async () => {
  vi.stubGlobal('window', {
    electronAPI: {
      intentListItems: vi
        .fn()
        .mockResolvedValue({ success: true, data: { items: [{ id: 'br-a' }], nextCursor: 'more' } }),
    },
  });
  await expect(selectMatchingIntentItems('ws', {})).rejects.toThrow('More than 200 rules match');
});
it('surfaces a failed IPC read instead of treating it as an empty selection', async () => {
  vi.stubGlobal('window', {
    electronAPI: { intentListItems: vi.fn().mockResolvedValue({ success: false, error: 'Connection unavailable' }) },
  });
  await expect(selectMatchingIntentItems('ws', {})).rejects.toThrow('Connection unavailable');
});
it('separates catalogue caches by production state and source identity', () => {
  const base = intentItemsQueryOptions('ws', {
    production: 'true',
    effectivity: 'planned',
    sourceRef: 'spec/a',
  }).queryKey;
  expect(base).not.toEqual(
    intentItemsQueryOptions('ws', { production: 'true', effectivity: 'effective', sourceRef: 'spec/a' }).queryKey,
  );
  expect(base).not.toEqual(
    intentItemsQueryOptions('ws', { production: 'true', effectivity: 'planned', sourceRef: 'spec/b' }).queryKey,
  );
  expect(intentSourceOptions('ws', 'uploads', false).enabled).toBe(false);
});
