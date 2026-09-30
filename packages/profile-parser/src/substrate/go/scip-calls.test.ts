import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { withOptionalIndexHost } from '../../facts/scip/index-host.js';
import { parseGoRepo } from './go-parser.js';
import { parseGo } from './go-cst.js';
import { goScipCallFacts } from './scip-calls.js';
import { StableIdGenerator } from '@coredoc/core';

const root = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__/scip');
let work: string | undefined;
afterEach(() => {
  if (work) rmSync(work, { recursive: true, force: true });
  work = undefined;
});
const profile = { parserId: 'scip-test', substrate: { language: 'go' as const, include: ['main.go'] } };

it('keeps generic free functions distinct from selector calls', async () => {
  const source = 'package demo\nfunc Run() { Work[int](); worker.Perform() }';
  const facts = goScipCallFacts(
    [{ relPath: 'main.go', source, root: await parseGo(source) }],
    new StableIdGenerator('fixture'),
  );
  expect(facts[0].calls.map((call) => [call.name, call.edge.isMethodCall])).toEqual([
    ['Work', false],
    ['Perform', true],
  ]);
});

it('joins actual compiler calls, including Unicode columns, without turning method values into calls', async () => {
  work = mkdtempSync(join(tmpdir(), 'go-scip-test-'));
  const index = join(work, 'index.scip');
  writeFileSync(index, Buffer.from(readFileSync(join(root, 'index.scip.base64'), 'utf8').trim(), 'base64'));
  copyFileSync(join(root, 'index.scip.sources.json'), `${index}.sources.json`);
  const prepare = vi.fn().mockResolvedValue({ path: index });
  await withOptionalIndexHost(prepare, () =>
    parseGoRepo(root, 'fixture', {}, { ...profile, substrate: { ...profile.substrate, analysis: { mode: 'basic' } } }),
  );
  expect(prepare).not.toHaveBeenCalled();
  const result = await withOptionalIndexHost(prepare, () => parseGoRepo(root, 'fixture', {}, profile));
  expect(prepare).toHaveBeenCalledWith({ language: 'go', fallback: true });
  expect(result.parseStats.analysis).toEqual({
    language: 'go',
    mode: 'enhanced',
    compilerReceiverTypes: false,
    fallback: false,
  });
  const names = new Map(result.functions.map((fn) => [fn.id, fn.name]));
  const precise = result.calls.filter((call) => call.provenance === 'scip');
  expect(precise.some((call) => names.get(call.callerId) === 'Run' && names.get(call.calleeId!) === 'Perform')).toBe(
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
    () => parseGoRepo(root, 'fixture', {}, profile),
  );
  expect(basic.parseStats.analysis?.fallback).toBe(false);
  expect(basic.parseStats.analysis?.mode).toBe('basic');
  const fail = () => Promise.reject(new Error('index unavailable'));
  await expect(
    withOptionalIndexHost(fail, () =>
      parseGoRepo(
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
      () => parseGoRepo(root, 'fixture', {}, profile),
    ),
  ).rejects.toMatchObject({ name: 'AbortError' });
});

it('reports fallback when cgo source is represented only by generated compiler documents', async () => {
  work = mkdtempSync(join(tmpdir(), 'go-scip-coverage-'));
  const index = join(work, 'index.scip');
  writeFileSync(index, Buffer.from(readFileSync(join(root, 'index.scip.base64'), 'utf8').trim(), 'base64'));
  copyFileSync(join(root, 'index.scip.sources.json'), `${index}.sources.json`);
  const allFiles = { ...profile, substrate: { ...profile.substrate, include: ['**/*.go'] } };
  const prepare = async () => ({ path: index });
  const result = await withOptionalIndexHost(prepare, () => parseGoRepo(root, 'fixture', {}, allFiles));
  expect(result.parseStats.analysis).toMatchObject({ mode: 'basic', fallback: true });
  expect(result.calls.some((call) => call.provenance === 'scip')).toBe(false);
  await expect(
    withOptionalIndexHost(prepare, () =>
      parseGoRepo(
        root,
        'fixture',
        {},
        {
          ...allFiles,
          substrate: { ...allFiles.substrate, analysis: { fallback: false } },
        },
      ),
    ),
  ).rejects.toThrow('covers 1/2 target files; missing cgo.go');
});
