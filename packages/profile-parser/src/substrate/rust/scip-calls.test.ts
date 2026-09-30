import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { withOptionalIndexHost } from '../../facts/scip/index-host.js';
import { parseRustRepo } from './rust-parser.js';
import { parseRust } from './rust-cst.js';
import { rustScipCallFacts } from './scip-calls.js';
import { StableIdGenerator } from '@coredoc/core';

const root = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__/scip');
let work: string | undefined;
afterEach(() => {
  if (work) rmSync(work, { recursive: true, force: true });
  work = undefined;
});
const profile = { parserId: 'scip-test', substrate: { language: 'rust' as const, include: ['**/*.rs'] } };

it('keeps associated functions and module calls distinct from receiver method calls', async () => {
  const source = 'fn run() { Worker::new(); module::work(); worker.perform::<u32>(); }';
  const facts = rustScipCallFacts(
    [{ relPath: 'lib.rs', source, root: await parseRust(source) }],
    new StableIdGenerator('fixture'),
  );
  expect(facts[0].calls.map((call) => [call.name, call.edge.isMethodCall])).toEqual([
    ['new', false],
    ['work', false],
    ['perform', true],
  ]);
});

it('joins actual compiler calls, including Unicode columns, without turning method values into calls', async () => {
  work = mkdtempSync(join(tmpdir(), 'rust-scip-test-'));
  const index = join(work, 'index.scip');
  writeFileSync(index, Buffer.from(readFileSync(join(root, 'index.scip.base64'), 'utf8').trim(), 'base64'));
  copyFileSync(join(root, 'index.scip.sources.json'), `${index}.sources.json`);
  const prepare = vi.fn().mockResolvedValue({ path: index });
  await withOptionalIndexHost(prepare, () =>
    parseRustRepo(
      root,
      'fixture',
      {},
      { ...profile, substrate: { ...profile.substrate, analysis: { mode: 'basic' } } },
    ),
  );
  expect(prepare).not.toHaveBeenCalled();
  const result = await withOptionalIndexHost(prepare, () => parseRustRepo(root, 'fixture', {}, profile));
  expect(prepare).toHaveBeenCalledWith({ language: 'rust', fallback: true });
  expect(result.parseStats.analysis).toEqual({
    language: 'rust',
    mode: 'enhanced',
    compilerReceiverTypes: false,
    fallback: false,
  });
  const names = new Map(result.functions.map((fn) => [fn.id, fn.name]));
  const precise = result.calls.filter((call) => call.provenance === 'scip');
  expect(precise.some((call) => names.get(call.callerId) === 'run' && names.get(call.calleeId!) === 'perform')).toBe(
    true,
  );
  // This function is compiled only if the fixture's build.rs successfully compiled and ran.
  expect(precise.some((call) => names.get(call.callerId) === 'built' && names.get(call.calleeId!) === 'perform')).toBe(
    true,
  );
  expect(result.calls.some((call) => call.calleeExpression?.includes('unused'))).toBe(false);
  expect(precise.every((call) => names.has(call.callerId) && names.has(call.calleeId!))).toBe(true);
  expect(result.parseStats.callResolution.resolvedCalls).toBeLessThanOrEqual(
    result.parseStats.callResolution.callSites,
  );
});

it('honors basic choice, strict enhanced and cancellation without downloading anything', async () => {
  const basic = await withOptionalIndexHost(
    async () => ({ basic: true }),
    () => parseRustRepo(root, 'fixture', {}, profile),
  );
  expect(basic.parseStats.analysis?.fallback).toBe(false);
  expect(basic.parseStats.analysis?.mode).toBe('basic');
  const fail = () => Promise.reject(new Error('index unavailable'));
  await expect(
    withOptionalIndexHost(fail, () =>
      parseRustRepo(
        root,
        'fixture',
        {},
        { ...profile, substrate: { ...profile.substrate, analysis: { fallback: false } } },
      ),
    ),
  ).rejects.toThrow('index unavailable');
  await expect(
    withOptionalIndexHost(
      () => Promise.reject(new DOMException('cancelled', 'AbortError')),
      () => parseRustRepo(root, 'fixture', {}, profile),
    ),
  ).rejects.toMatchObject({ name: 'AbortError' });
});
