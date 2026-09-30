/** IA-01 fixture preparation. No live writes, model calls, or production binding sync. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openIntentGraphFixture } from '@coredoc/db/testing';
import { changedLineRanges, replaceItemAnchors, selectChangedNodes } from './intent-ci-anchor-baseline.js';

const root = resolve(import.meta.dirname, '../..');
const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trimEnd();
interface Anchor {
  itemId: string;
  repoKey: string;
  nodeId: string;
  nodeType: string;
  capturedVersionedId: string;
  rationale: string | null;
  createdAt: string;
  source: string;
}
interface Fixture {
  capturedAt: string;
  graph: { graphCommit: string; graphRepoHash: string; repoKey: string; sha256: string };
  anchors: Anchor[];
  items: Array<{ id: string; authority: string }>;
}
const fixtureBytes = readFileSync(resolve(root, 'evals/cases-intent/context-first/fixture.json'));
const fixture = JSON.parse(fixtureBytes.toString()) as Fixture;
const pr = JSON.parse(readFileSync(resolve(root, 'evals/cases-intent/ci-anchors/pr112.json'), 'utf8')) as {
  number: number;
  base: string;
  head: string;
  bodySha256: string;
  deliveredIds: string[];
};
const snapshot = process.env.INTENT_CONTEXT_AB_GRAPH;
if (!snapshot) throw new Error('INTENT_CONTEXT_AB_GRAPH must name the frozen graph');
if (hash(readFileSync(snapshot)) !== fixture.graph.sha256) throw new Error('Frozen graph hash mismatch');
const output = resolve(root, '.scratch/intent-loop-v3/context-first/remaining-ci-anchors-evidence');
mkdirSync(output, { recursive: true });
const base = git('merge-base', pr.base, fixture.graph.graphCommit);
const diff = git(
  '-c',
  'core.quotepath=false',
  'diff',
  '--no-ext-diff',
  '--no-textconv',
  '--no-renames',
  '--unified=0',
  base,
  fixture.graph.graphCommit,
);
const changes = changedLineRanges(diff);
const excluded: Array<{ path: string; reason: string }> = [];
const candidates: Array<{
  id: string;
  type: string;
  path: string;
  startLine: number;
  endLine?: number;
  versionedId: string;
  kind: 'file' | 'symbol';
}> = [];
const graph = await openIntentGraphFixture(snapshot, { readOnly: true });
try {
  for (const file of changes) {
    if (
      !/\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(file.path) ||
      /(?:^|\/)(?:docs|\.scratch|evals|__tests__|test|tests)\/|\.(?:test|spec)\.[^.]+$/.test(file.path)
    ) {
      excluded.push({ path: file.path, reason: 'not_code_or_test_docs_policy' });
      continue;
    }
    const nodes = (await graph.repository.listSymbolsInFile(file.path, [fixture.graph.graphRepoHash])).filter(
      (node) => node.filePath === file.path,
    );
    if (!nodes.length) {
      excluded.push({ path: file.path, reason: 'graph_file_unresolved' });
      continue;
    }
    const unknown = nodes.filter((node) => node.type !== 'file' && (!node.startLine || !node.endLine));
    if (unknown.length) excluded.push({ path: file.path, reason: `${unknown.length}_symbols_without_ranges` });
    for (const kind of ['symbol', 'file'] as const) {
      for (const node of selectChangedNodes(nodes, file.ranges, kind)) {
        const stored = await graph.repository.getNodeWithProperties(node.id, [fixture.graph.graphRepoHash]);
        const versionedId = stored?.properties.versionedId;
        if (typeof versionedId !== 'string' || !versionedId.startsWith(`${node.id}@`)) {
          excluded.push({ path: file.path, reason: 'node_without_versioned_id' });
          continue;
        }
        candidates.push({
          id: node.id,
          type: node.type,
          path: file.path,
          startLine: node.startLine,
          endLine: node.endLine,
          versionedId,
          kind,
        });
      }
    }
  }
} finally {
  await graph.close();
}
const deliveredIds = pr.deliveredIds;
for (const id of deliveredIds)
  if (!fixture.items.some((item) => item.id === id && item.authority === 'accepted'))
    throw new Error(`PR item absent/unaccepted in fixture: ${id}`);
const variants: Array<Record<string, unknown>> = [];
for (const stratum of ['T1a', 'T1b', 'cold-start-T1b'] as const) {
  const ids = stratum === 'T1a' ? deliveredIds.slice(0, 1) : deliveredIds;
  for (const kind of ['symbol', 'file'] as const) {
    if (stratum === 'cold-start-T1b' && kind === 'file') continue;
    const targets = candidates.filter((candidate) => candidate.kind === kind);
    const additions: Anchor[] = ids.flatMap((itemId) =>
      targets.map((target) => ({
        itemId,
        repoKey: fixture.graph.repoKey,
        nodeId: target.id,
        nodeType: target.type,
        capturedVersionedId: target.versionedId,
        rationale: `T1 PR #${pr.number} touchpoint; not conformance evidence`,
        createdAt: fixture.capturedAt,
        source: 'ci',
      })),
    );
    const label = `${stratum}-${kind}`;
    const anchors =
      stratum === 'cold-start-T1b' ? additions : replaceItemAnchors(fixture.anchors, new Set(ids), additions);
    const report = {
      schemaVersion: 1,
      label,
      graphSha256: fixture.graph.sha256,
      fixtureSha256: hash(fixtureBytes),
      anchors,
      source: {
        pr: pr.number,
        bodySha256: pr.bodySha256,
        actualPrHead: pr.head,
        graphCommit: fixture.graph.graphCommit,
        diffBase: base,
        diffSha256: hash(diff),
        codeScope:
          'historical PR code prefix at graph commit; final real PR trailers, not a claim of historical body state',
        stratum:
          stratum === 'T1a'
            ? 'counterfactual singleton: first actual delivered item, same code diff including collateral changes'
            : 'actual multi-item trailer set',
        coldStart: stratum === 'cold-start-T1b',
        replacedItemIds: ids,
      },
      targets,
      excluded,
      changedFiles: changes.length,
      wouldExceedPrototypeApplyCap: additions.length > 200,
      unsupportedBootstrapItems: fixture.items
        .filter((item) => item.authority === 'accepted' && !ids.includes(item.id))
        .map((item) => item.id),
      modelCalls: 0,
    };
    const path = resolve(output, `${label}.json`);
    writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
    variants.push({
      label,
      path,
      anchors: anchors.length,
      targets: targets.length,
      replacedItems: ids.length,
      exceedsApplyCap: report.wouldExceedPrototypeApplyCap,
    });
  }
}
writeFileSync(resolve(output, 'source.diff'), diff);
writeFileSync(resolve(output, 'variants.json'), `${JSON.stringify(variants, null, 2)}\n`);
console.log(
  JSON.stringify(
    { diffBase: base, graphCommit: fixture.graph.graphCommit, variants, excluded: excluded.length },
    null,
    2,
  ),
);
