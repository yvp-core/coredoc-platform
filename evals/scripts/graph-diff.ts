/**
 * Graph regression diff: compare two parses of the SAME source (before/after a parser change)
 * and separate the changes a parser change is allowed to make from the ones it must not.
 *
 * Identity across the two graphs is by source location, never by node id: a parser change may
 * legitimately rename ids (e.g. a same-named second function becoming `name#2`), and an id
 * comparison would report that as a removal plus an addition.
 *
 * Must not change: entrypoints, entities, db operations and external calls (by location), and
 * every resolved call edge, unless its callee or caller node was folded into an enclosing
 * function. Expected changes are counted and reported; unexpected ones fail the check.
 */
import type { ParsedRepo } from '@coredoc/core/types';

type Fn = ParsedRepo['functions'][number];

export interface GraphDiffOptions {
  /** Unexplained lost resolved call edges tolerated, as a fraction of the "before" resolved edges. */
  maxLostEdgeRate?: number;
}

export interface Bucket {
  count: number;
  samples: string[];
}

export interface GraphDiff {
  repo: string;
  counts: Record<string, { before: number; after: number }>;
  nodes: { folded: Bucket; added: Bucket; removed: Bucket };
  entrypoints: { missing: Bucket; added: Bucket; handlerFolded: Bucket; handlerChanged: Bucket };
  entities: { missing: Bucket; added: Bucket };
  dbOperations: {
    missing: Bucket;
    added: Bucket;
    performerFolded: Bucket;
    performerCorrected: Bucket;
    performerChanged: Bucket;
  };
  externalCalls: {
    missing: Bucket;
    added: Bucket;
    callerFolded: Bucket;
    callerCorrected: Bucket;
    callerChanged: Bucket;
  };
  calls: {
    resolvedBefore: number;
    resolvedAfter: number;
    gained: Bucket;
    callerRefined: Bucket;
    callerChanged: Bucket;
    lostToFold: Bucket;
    becameRecursion: Bucket;
    lost: Bucket;
  };
  integrity: { before: number; after: number };
  failures: string[];
}

const SAMPLES = 8;
const bucket = (): Bucket => ({ count: 0, samples: [] });
const add = (b: Bucket, sample: string): void => {
  b.count++;
  if (b.samples.length < SAMPLES) b.samples.push(sample);
};

/** Location identity of a function node: stable across id renames. */
export const fnKey = (f: Fn): string => `${f.location.filePath}:${f.location.startLine}:${f.name}`;

function indexFunctions(repo: ParsedRepo) {
  const byId = new Map(repo.functions.map((f) => [f.id, f]));
  const byKey = new Map(repo.functions.map((f) => [fnKey(f), f]));
  return { byId, byKey };
}

/** True when `outer` strictly encloses `inner` in the same file. */
const encloses = (outer: Fn, inner: { filePath: string; startLine: number; endLine: number }): boolean =>
  outer.location.filePath === inner.filePath &&
  outer.location.startLine <= inner.startLine &&
  outer.location.endLine >= inner.endLine &&
  !(outer.location.startLine === inner.startLine && outer.location.endLine === inner.endLine);

const locKey = (l: { filePath: string; startLine: number }): string => `${l.filePath}:${l.startLine}`;

type Call = ParsedRepo['calls'][number];

/**
 * A second record of one call: a bare-name edge on a single line (`load`, the form a SCIP pass
 * mints) inside the span of another record of the same caller→callee whose expression names it
 * (`this.repo\n  .load`). Parsers that minted a fresh edge next to an unresolved-then-resolved
 * structural one produced these; counting both would read their removal as a lost call.
 */
function isSiteDuplicate(c: Call, samePair: Call[]): boolean {
  const name = c.calleeExpression;
  if (!name || /[.\s]/.test(name) || c.location.startLine !== c.location.endLine) return false;
  return samePair.some(
    (o) =>
      o !== c &&
      o.location.filePath === c.location.filePath &&
      o.location.startLine <= c.location.startLine &&
      o.location.endLine >= c.location.startLine &&
      (o.calleeExpression ?? '').replace(/\s+/g, '').endsWith(`.${name}`),
  );
}

/**
 * "Before" functions absent from "after", by location key → the innermost "after" function that
 * encloses them (they were folded into it), or undefined when none does (they were removed).
 */
export function foldMap(before: ParsedRepo, after: ParsedRepo): Map<string, Fn | undefined> {
  const afterKeys = new Set(after.functions.map(fnKey));
  const afterByFile = new Map<string, Fn[]>();
  for (const f of after.functions) {
    const list = afterByFile.get(f.location.filePath) ?? [];
    list.push(f);
    afterByFile.set(f.location.filePath, list);
  }
  const out = new Map<string, Fn | undefined>();
  for (const f of before.functions) {
    const key = fnKey(f);
    if (afterKeys.has(key)) continue;
    const span = { filePath: f.location.filePath, startLine: f.location.startLine, endLine: f.location.endLine };
    out.set(
      key,
      (afterByFile.get(f.location.filePath) ?? [])
        .filter((o) => encloses(o, span))
        .sort((x, y) => y.location.startLine - x.location.startLine)[0],
    );
  }
  return out;
}

export function diffParsedRepos(before: ParsedRepo, after: ParsedRepo, opts: GraphDiffOptions = {}): GraphDiff {
  const maxLostEdgeRate = opts.maxLostEdgeRate ?? 0.005;
  const b = indexFunctions(before);
  const a = indexFunctions(after);

  // ── nodes ────────────────────────────────────────────────────────────────
  const nodes = { folded: bucket(), added: bucket(), removed: bucket() };
  /** "before" function key → the "after" function it was folded into. */
  const foldedInto = new Map<string, Fn>();
  for (const [key, host] of foldMap(before, after)) {
    if (host) {
      foldedInto.set(key, host);
      add(nodes.folded, `${key} → ${host.name}`);
    } else add(nodes.removed, key);
  }
  for (const key of a.byKey.keys()) if (!b.byKey.has(key)) add(nodes.added, key);

  /** Same function in both graphs, or the "before" function was folded into this "after" one. */
  const relation = (beforeFn: Fn | undefined, afterFn: Fn | undefined): 'same' | 'folded' | 'changed' => {
    if (!beforeFn || !afterFn) return beforeFn === afterFn ? 'same' : 'changed';
    if (fnKey(beforeFn) === fnKey(afterFn)) return 'same';
    return foldedInto.get(fnKey(beforeFn)) === afterFn ? 'folded' : 'changed';
  };

  // ── entrypoints ──────────────────────────────────────────────────────────
  const entrypoints = { missing: bucket(), added: bucket(), handlerFolded: bucket(), handlerChanged: bucket() };
  const afterEps = new Map(after.entrypoints.map((e) => [e.id, e]));
  for (const e of before.entrypoints) {
    const ae = afterEps.get(e.id);
    if (!ae) {
      add(entrypoints.missing, `${e.id} ${locKey(e.location)}`);
      continue;
    }
    const rel = relation(b.byId.get(e.handlerId), a.byId.get(ae.handlerId));
    if (rel === 'folded') add(entrypoints.handlerFolded, e.id);
    if (rel === 'changed') add(entrypoints.handlerChanged, `${e.id}: ${e.handlerId} → ${ae.handlerId}`);
  }
  const beforeEpIds = new Set(before.entrypoints.map((e) => e.id));
  for (const e of after.entrypoints) if (!beforeEpIds.has(e.id)) add(entrypoints.added, e.id);

  // ── entities ─────────────────────────────────────────────────────────────
  const entities = { missing: bucket(), added: bucket() };
  const afterEntities = new Set(after.entities.map((e) => e.id));
  const beforeEntities = new Set(before.entities.map((e) => e.id));
  for (const id of beforeEntities) if (!afterEntities.has(id)) add(entities.missing, id);
  for (const id of afterEntities) if (!beforeEntities.has(id)) add(entities.added, id);

  // ── side effects: db operations and external calls, by site ──────────────
  const sideEffects = <T extends { location: { filePath: string; startLine: number } }>(
    beforeList: T[],
    afterList: T[],
    siteKey: (x: T) => string,
    ownerId: (x: T) => string,
  ) => {
    const out = { missing: bucket(), added: bucket(), folded: bucket(), corrected: bucket(), changed: bucket() };
    const afterBySite = new Map<string, T>();
    for (const x of afterList) afterBySite.set(siteKey(x), x);
    const beforeSites = new Set<string>();
    for (const x of beforeList) {
      const site = siteKey(x);
      beforeSites.add(site);
      const ax = afterBySite.get(site);
      if (!ax) {
        add(out.missing, site);
        continue;
      }
      const owner = a.byId.get(ownerId(ax));
      const rel = relation(b.byId.get(ownerId(x)), owner);
      if (rel === 'folded') add(out.folded, `${site} → ${owner?.name}`);
      // An owner that now spans the site, where the old one did not, is a merged namesake split
      // back into the function that really contains it.
      const holds = (f: Fn | undefined) =>
        !!f && f.location.filePath === ax.location.filePath && f.location.startLine <= ax.location.startLine && ax.location.startLine <= f.location.endLine;
      if (rel === 'changed' && holds(owner) && !holds(b.byId.get(ownerId(x)))) add(out.corrected, `${site} → ${owner?.name}`);
      else if (rel === 'changed') add(out.changed, `${site}: ${ownerId(x)} → ${ownerId(ax)}`);
    }
    for (const site of afterBySite.keys()) if (!beforeSites.has(site)) add(out.added, site);
    return out;
  };
  const db = sideEffects(
    before.dbOperations,
    after.dbOperations,
    (o) => `${locKey(o.location)}|${o.entityName ?? o.entityId ?? ''}|${o.operation}`,
    (o) => o.performerId,
  );
  const ext = sideEffects(
    before.externalCalls,
    after.externalCalls,
    (c) => `${locKey(c.location)}|${c.serviceName}|${c.method}`,
    (c) => c.callerId,
  );

  // ── resolved call edges, matched by call site ────────────────────────────
  // A site is (file, callee, line span). A multi-line chain (`this\n  .setStage()`) may sit at the
  // call's first line in one parse and at the name token's line in the other, so spans may overlap
  // rather than match exactly. The caller of a matched site is then compared on its own.
  interface Site {
    caller: Fn;
    callee: Fn;
    file: string;
    start: number;
    end: number;
  }
  const sitesOf = (repo: ParsedRepo, byId: Map<string, Fn>): Site[] => {
    const byPair = new Map<string, Call[]>();
    for (const c of repo.calls) {
      if (!c.calleeId || !byId.has(c.calleeId) || !byId.has(c.callerId)) continue;
      const k = `${c.callerId}|${c.calleeId}`;
      byPair.set(k, [...(byPair.get(k) ?? []), c]);
    }
    // Identical calls on one line are one edge by edge identity (caller + expression + line).
    const seen = new Set<string>();
    const out: Site[] = [];
    for (const [pairKey, cs] of byPair) {
      for (const c of cs) {
        if (isSiteDuplicate(c, cs)) continue;
        const k = `${pairKey}|${locKey(c.location)}|${(c.calleeExpression ?? '').replace(/\s+/g, '')}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({
          caller: byId.get(c.callerId)!,
          callee: byId.get(c.calleeId!)!,
          file: c.location.filePath,
          start: c.location.startLine,
          end: c.location.endLine,
        });
      }
    }
    return out;
  };
  const beforeSites = sitesOf(before, b.byId);
  const afterSites = sitesOf(after, a.byId);
  const afterBySiteKey = new Map<string, Site[]>();
  for (const s of afterSites) {
    const k = `${s.file}|${fnKey(s.callee)}`;
    afterBySiteKey.set(k, [...(afterBySiteKey.get(k) ?? []), s]);
  }
  const matched = new Set<Site>();
  const calls = {
    resolvedBefore: beforeSites.length,
    resolvedAfter: afterSites.length,
    gained: bucket(),
    callerRefined: bucket(),
    callerChanged: bucket(),
    lostToFold: bucket(),
    becameRecursion: bucket(),
    lost: bucket(),
  };
  const spanOf = (f: Fn) => ({ filePath: f.location.filePath, startLine: f.location.startLine, endLine: f.location.endLine });
  for (const s of beforeSites) {
    const candidates = (afterBySiteKey.get(`${s.file}|${fnKey(s.callee)}`) ?? []).filter((x) => !matched.has(x));
    // Exact line first, then the tightest overlapping span (a chain's calls share their first line).
    const hit =
      candidates.find((x) => x.start === s.start) ??
      candidates
        .filter((x) => (x.start <= s.start && s.start <= x.end) || (s.start <= x.start && x.start <= s.end))
        .sort((x, y) => x.end - x.start - (y.end - y.start))[0];
    const label = `${s.file}:${s.start} ${s.caller.name} → ${fnKey(s.callee)}`;
    if (hit) {
      matched.add(hit);
      const rel = relation(s.caller, hit.caller);
      // A caller moved between nested scopes is attribution getting more precise (position, not
      // line, decides which scope a call is in); an unrelated caller is a regression.
      const nested = encloses(s.caller, spanOf(hit.caller)) || encloses(hit.caller, spanOf(s.caller));
      if (rel === 'changed' && nested) add(calls.callerRefined, `${label} now in ${hit.caller.name}`);
      else if (rel === 'changed') add(calls.callerChanged, `${label} now in ${hit.caller.name}`);
      continue;
    }
    const host = foldedInto.get(fnKey(s.caller)) ?? s.caller;
    // Calling a folded function is no longer an edge; a call into the function it was folded into
    // from inside it is now recursion, and self-calls are not edges.
    if (foldedInto.has(fnKey(s.callee))) add(calls.lostToFold, label);
    else if (fnKey(host) === fnKey(s.callee)) add(calls.becameRecursion, label);
    else add(calls.lost, label);
  }
  for (const s of afterSites) if (!matched.has(s)) add(calls.gained, `${s.file}:${s.start} ${s.caller.name} → ${fnKey(s.callee)}`);

  const counts: GraphDiff['counts'] = {};
  for (const k of ['functions', 'classes', 'entrypoints', 'entities', 'dbOperations', 'externalCalls', 'calls'] as const)
    counts[k] = { before: before[k].length, after: after[k].length };

  const integrity = {
    before: before.stats.integrity?.danglingRefs ?? 0,
    after: after.stats.integrity?.danglingRefs ?? 0,
  };

  const failures: string[] = [];
  const must = (n: number, what: string): void => {
    if (n > 0) failures.push(`${n} ${what}`);
  };
  must(entrypoints.missing.count, 'entrypoints missing');
  must(entrypoints.handlerChanged.count, 'entrypoint handlers changed (not by folding)');
  must(entities.missing.count, 'entities missing');
  must(db.missing.count, 'db operations missing');
  must(db.changed.count, 'db operation performers changed (not by folding)');
  must(ext.missing.count, 'external calls missing');
  must(ext.changed.count, 'external call callers changed (not by folding)');
  must(nodes.removed.count, 'function nodes removed without an enclosing function to fold into');
  if (integrity.after > integrity.before) failures.push(`dangling refs rose ${integrity.before} → ${integrity.after}`);
  if (calls.callerChanged.count > calls.resolvedBefore * maxLostEdgeRate)
    failures.push(`${calls.callerChanged.count} resolved call edges moved to an unrelated caller`);
  if (calls.lost.count > calls.resolvedBefore * maxLostEdgeRate)
    failures.push(
      `${calls.lost.count} resolved call edges lost (> ${(maxLostEdgeRate * 100).toFixed(1)}% of ${calls.resolvedBefore})`,
    );

  return {
    repo: after.name,
    counts,
    nodes,
    entrypoints,
    entities,
    dbOperations: {
      missing: db.missing,
      added: db.added,
      performerFolded: db.folded,
      performerCorrected: db.corrected,
      performerChanged: db.changed,
    },
    externalCalls: {
      missing: ext.missing,
      added: ext.added,
      callerFolded: ext.folded,
      callerCorrected: ext.corrected,
      callerChanged: ext.changed,
    },
    calls,
    integrity,
    failures,
  };
}

/** Markdown report of one diff. */
export function formatGraphDiff(d: GraphDiff): string {
  const lines: string[] = [`## ${d.repo}: ${d.failures.length ? 'FAIL' : 'PASS'}`, ''];
  for (const f of d.failures) lines.push(`- ✗ ${f}`);
  if (d.failures.length) lines.push('');
  lines.push('| collection | before | after |', '| --- | ---: | ---: |');
  for (const [k, v] of Object.entries(d.counts)) lines.push(`| ${k} | ${v.before} | ${v.after} |`);
  lines.push(
    '',
    `Resolved call sites: ${d.calls.resolvedBefore} → ${d.calls.resolvedAfter} ` +
      `(gained ${d.calls.gained.count}, caller refined ${d.calls.callerRefined.count}, ` +
      `caller changed ${d.calls.callerChanged.count}, lost to folding ${d.calls.lostToFold.count}, ` +
      `became recursion ${d.calls.becameRecursion.count}, lost ${d.calls.lost.count}). ` +
      `Dangling refs: ${d.integrity.before} → ${d.integrity.after}.`,
    '',
  );
  const section = (title: string, buckets: Record<string, Bucket>): void => {
    const nonEmpty = Object.entries(buckets).filter(([, v]) => v.count > 0);
    if (!nonEmpty.length) return;
    lines.push(`### ${title}`);
    for (const [k, v] of nonEmpty) {
      lines.push(`- ${k}: ${v.count}`);
      for (const s of v.samples) lines.push(`  - \`${s}\``);
    }
    lines.push('');
  };
  section('Function nodes', d.nodes);
  section('Entrypoints', d.entrypoints);
  section('Entities', d.entities);
  section('DB operations', d.dbOperations);
  section('External calls', d.externalCalls);
  const { resolvedBefore: _b, resolvedAfter: _a, ...callBuckets } = d.calls;
  section('Call edges', callBuckets);
  return lines.join('\n');
}
