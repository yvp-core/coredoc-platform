import { pythonProvider } from '../../providers/python.js';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { withOptionalIndexHost } from '../../facts/scip/index-host.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__/scip');
let work: string | undefined;
afterEach(() => {
  if (work) rmSync(work, { recursive: true, force: true });
  work = undefined;
});
const profile = { parserId: 'scip-test', substrate: { language: 'python' as const, include: ['**/*.py'] } };

it('joins actual compiler calls, including Unicode columns, without turning method values into calls', async () => {
  work = mkdtempSync(join(tmpdir(), 'python-scip-test-'));
  const index = join(work, 'index.scip');
  writeFileSync(index, Buffer.from(readFileSync(join(root, 'index.scip.base64'), 'utf8').trim(), 'base64'));
  copyFileSync(join(root, 'index.scip.sources.json'), `${index}.sources.json`);
  const prepare = vi.fn().mockResolvedValue({ path: index });
  await withOptionalIndexHost(prepare, () =>
    pythonProvider.parse(
      { ...profile, substrate: { ...profile.substrate, analysis: { mode: 'basic' } } },
      { repoRoot: root, repoName: 'fixture' },
    ),
  );
  expect(prepare).not.toHaveBeenCalled();
  const result = await withOptionalIndexHost(prepare, () =>
    pythonProvider.parse(profile, { repoRoot: root, repoName: 'fixture' }),
  );
  expect(prepare).toHaveBeenCalledWith({ language: 'python', fallback: true });
  expect(result.stats.analysis?.[0]).toEqual({
    language: 'python',
    mode: 'enhanced',
    compilerReceiverTypes: false,
    fallback: false,
  });
  const names = new Map(result.functions.map((fn) => [fn.id, fn.name]));
  const precise = result.calls.filter((call) => call.provenance === 'scip');
  expect(precise.some((call) => names.get(call.callerId) === 'run' && names.get(call.calleeId!) === 'perform')).toBe(
    true,
  );
  expect(result.calls.some((call) => call.calleeExpression?.includes('unused'))).toBe(false);
  expect(precise.every((call) => names.has(call.callerId) && names.has(call.calleeId!))).toBe(true);
  expect(result.stats.callResolution.resolvedCalls).toBeLessThanOrEqual(result.stats.callResolution.callSites);
});

it('honors basic choice, strict enhanced and cancellation without downloading anything', async () => {
  const basic = await withOptionalIndexHost(
    async () => ({ basic: true }),
    () => pythonProvider.parse(profile, { repoRoot: root, repoName: 'fixture' }),
  );
  expect(basic.stats.analysis?.[0]?.fallback).toBe(false);
  expect(basic.stats.analysis?.[0]?.mode).toBe('basic');
  const fail = () => Promise.reject(new Error('index unavailable'));
  await expect(
    withOptionalIndexHost(fail, () =>
      pythonProvider.parse(
        { ...profile, substrate: { ...profile.substrate, analysis: { fallback: false } } },
        { repoRoot: root, repoName: 'fixture' },
      ),
    ),
  ).rejects.toThrow('index unavailable');
  await expect(
    withOptionalIndexHost(
      () => Promise.reject(new DOMException('cancelled', 'AbortError')),
      () => pythonProvider.parse(profile, { repoRoot: root, repoName: 'fixture' }),
    ),
  ).rejects.toMatchObject({ name: 'AbortError' });
});
