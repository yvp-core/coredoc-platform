/**
 * Pre-deploy MCP regression check for a parser change: load two parses of the same source into two
 * throwaway Ladybug graphs, ask both the same deterministic questions through the real MCP tool
 * handlers, and compare the answers. No model calls.
 *
 * Questions:
 * - `explain "METHOD /path"` for every HTTP entrypoint: call tree, entities, external services.
 * - `find_callers` (depth 3) and `analyze_change_impact` for a sample of called functions.
 *
 * Answers are compared by source location; a "before" function folded into an enclosing one in
 * "after" counts as that enclosing function (see graph-diff.ts).
 *
 * Usage:
 *   pnpm --filter @coredoc/evals mcp:regression <before.json> <after.json> [--sample=200]
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ParsedRepo } from '@coredoc/core/types';
import { transformParsedRepo } from '@coredoc/db';
import { LadybugDriver, LadybugRepository } from '@coredoc/db/ladybug';
import { handleAnalyzeChangeImpact, handleExplain, handleFindCallers } from '@coredoc/mcp/tools';
import { fnKey, foldMap } from './graph-diff.js';

type Fn = ParsedRepo['functions'][number];
type Handler = typeof handleExplain;
interface Located {
  name?: string;
  filePath?: string;
  startLine?: number;
}

const FULL = { includeBasic: true, includeSummaries: true, includeRefs: true, includeFullDetails: true };

async function loadGraph(parsed: ParsedRepo, path: string) {
  const { nodes, edges } = transformParsedRepo(parsed);
  const driver = new LadybugDriver(path, { readOnly: false, ftsMode: 'bootstrap', initializeSchema: true });
  await driver.initialize();
  const repository = new LadybugRepository(driver);
  await repository.pushNodes(nodes);
  await repository.pushEdges(edges);
  const scope = { currentPath: '/', resolvedRepos: [parsed.name], repoHashes: [parsed.id], crossRepoEnabled: false };
  const ask = async (handler: Handler, args: Record<string, unknown>): Promise<unknown> => {
    const res = await handler(args, scope, 'raw', 'full', FULL, repository);
    return res.isError ? undefined : res.data;
  };
  return { ask, close: () => driver.close() };
}

/** Location keys of the functions/elements an answer lists. */
const keysOf = (items: unknown): string[] =>
  Array.isArray(items)
    ? (items as Located[]).filter((i) => i?.filePath).map((i) => `${i.filePath}:${i.startLine}:${i.name}`)
    : [];

interface Comparison {
  question: string;
  lost: string[];
  gained: string[];
  /** Items in the "after" answer. */
  size: number;
  /** The "after" answer filled the tool's cap; losses are not judged. */
  capped?: boolean;
}

/**
 * `capped`: the "after" answer says it was cut at the tool's cap. An item missing from a cut list
 * may only have been pushed past the cap by new findings: not a loss.
 */
function compare(
  question: string,
  before: string[],
  after: string[],
  mapBefore: (k: string) => string,
  capped = false,
): Comparison {
  const b = new Set(before.map(mapBefore));
  const a = new Set(after);
  const lost = capped ? [] : [...b].filter((k) => !a.has(k));
  return { question, lost, gained: [...a].filter((k) => !b.has(k)), size: a.size, capped };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const files = args.filter((a) => !a.startsWith('--'));
  const sample = Number(args.find((a) => a.startsWith('--sample='))?.slice(9) ?? 200);
  if (files.length !== 2) {
    console.error('Usage: mcp-regression <before.json> <after.json> [--sample=200]');
    process.exit(2);
  }
  const [before, after] = files.map((f) => JSON.parse(readFileSync(f, 'utf8')) as ParsedRepo);
  const folds = foldMap(before, after);
  // A folded "before" function answers as the function it was folded into.
  const mapBefore = (k: string): string => {
    const host = folds.get(k);
    return host ? fnKey(host) : k;
  };

  const dir = mkdtempSync(join(tmpdir(), 'mcp-regression-'));
  const graphs = { before: await loadGraph(before, join(dir, 'before.lbdb')), after: await loadGraph(after, join(dir, 'after.lbdb')) };
  const results: Comparison[] = [];
  try {
    // Every HTTP entrypoint, explained.
    for (const e of after.entrypoints) {
      const d = e.details as { type?: string; method?: string; fullPath?: string; path?: string } | undefined;
      if (d?.type !== 'http' || !d.method || !(d.fullPath ?? d.path)) continue;
      const target = `${d.method} ${d.fullPath ?? d.path}`;
      const [b, a] = await Promise.all([
        graphs.before.ask(handleExplain, { target }),
        graphs.after.ask(handleExplain, { target }),
      ]);
      const pick = (r: unknown) => r as { callTree?: unknown; entities?: unknown; externalServices?: string[] } | undefined;
      results.push(compare(`explain ${target} · callTree`, keysOf(pick(b)?.callTree), keysOf(pick(a)?.callTree), mapBefore));
      results.push(
        compare(
          `explain ${target} · entities+services`,
          [...(pick(b)?.externalServices ?? []), ...keysOf(pick(b)?.entities)],
          [...(pick(a)?.externalServices ?? []), ...keysOf(pick(a)?.entities)],
          (k) => k,
        ),
      );
    }

    // A deterministic sample of called functions that exist in both graphs.
    const afterKeys = new Set(after.functions.map(fnKey));
    const called = new Set(before.calls.filter((c) => c.calleeId).map((c) => c.calleeId));
    const candidates = before.functions
      .filter((f) => called.has(f.id) && afterKeys.has(fnKey(f)) && !f.name.includes('@'))
      .sort((x, y) => fnKey(x).localeCompare(fnKey(y)));
    const step = Math.max(1, Math.floor(candidates.length / sample));
    const targets: Fn[] = candidates.filter((_, i) => i % step === 0).slice(0, sample);
    const className = (f: Fn) => f.classId?.split(':').pop();
    for (const f of targets) {
      const target = f.kind === 'method' && className(f) ? `${className(f)}.${f.name}` : f.name;
      const q = { functionName: target, target, fileHint: f.location.filePath, depth: 3, limit: 500 };
      const [bc, ac] = await Promise.all([graphs.before.ask(handleFindCallers, q), graphs.after.ask(handleFindCallers, q)]);
      const callers = (r: unknown) => keysOf((r as { callers?: unknown } | undefined)?.callers);
      // Both tools say when a list was cut at its cap (`truncated`).
      const cut = (r: unknown, list: 'callers' | 'entrypoints') =>
        !!(r as { truncated?: Record<string, boolean> } | undefined)?.truncated?.[list];
      results.push(compare(`find_callers ${fnKey(f)}`, callers(bc), callers(ac), mapBefore, cut(ac, 'callers')));
      const [bi, ai] = await Promise.all([
        graphs.before.ask(handleAnalyzeChangeImpact, q),
        graphs.after.ask(handleAnalyzeChangeImpact, q),
      ]);
      const eps = (r: unknown) =>
        ((r as { affectedEntrypoints?: { id?: string }[] } | undefined)?.affectedEntrypoints ?? []).map((e) => e.id ?? '');
      results.push(
        compare(`analyze_change_impact ${fnKey(f)} · entrypoints`, eps(bi), eps(ai), (k) => k, cut(ai, 'entrypoints')),
      );
    }
  } finally {
    await graphs.before.close();
    await graphs.after.close();
    rmSync(dir, { recursive: true, force: true });
  }

  const byTool = new Map<
    string,
    { total: number; nonEmpty: number; items: number; capped: number; same: number; gainedOnly: number; lost: Comparison[] }
  >();
  for (const r of results) {
    const tool = r.question.split(' ')[0] + (r.question.includes(' · ') ? ` · ${r.question.split(' · ')[1]}` : '');
    const t = byTool.get(tool) ?? { total: 0, nonEmpty: 0, items: 0, capped: 0, same: 0, gainedOnly: 0, lost: [] };
    if (r.capped) t.capped++;
    t.total++;
    if (r.size) t.nonEmpty++;
    t.items += r.size;
    if (r.lost.length) t.lost.push(r);
    else if (r.gained.length) t.gainedOnly++;
    else t.same++;
    byTool.set(tool, t);
  }
  console.log(`## MCP regression: ${after.name}\n`);
  console.log(
    '| question | asked | non-empty answers | items | at cap | same | only gained | lost something |\n' +
      '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  );
  for (const [tool, t] of byTool)
    console.log(
      `| ${tool} | ${t.total} | ${t.nonEmpty} | ${t.items} | ${t.capped} | ${t.same} | ${t.gainedOnly} | ${t.lost.length} |`,
    );
  const losses = results.filter((r) => r.lost.length);
  for (const r of losses.slice(0, 15)) console.log(`\n- ${r.question}: lost ${r.lost.slice(0, 5).join(', ')}`);
  process.exit(losses.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
