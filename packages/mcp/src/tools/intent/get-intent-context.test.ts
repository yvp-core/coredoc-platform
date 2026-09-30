import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IntentOverlayStatus, IntentValidationCode, LEGACY_SCHEMA_REMEDIATION } from '@coredoc/core';
import type { IGraphReadRepository } from '@coredoc/db';
import { AnchorStatus, NodeType, SnapshotFreshness, closeProjectDatabases, openProjectDatabase } from '@coredoc/db';
import type { GraphNode } from '@coredoc/db';
import { generateRepoHash } from '../../scope-resolver.js';
import { resolveDetailLevel } from '../../detail-level.js';
import type { DetailLevel, ScopeContext } from '../../types.js';
import {
  INTENT_ANCHOR_WARNING_COMPACT,
  handleGetIntentContext,
  type IntentContextResponse,
  type IntentIndexResponse,
} from './get-intent-context.js';

let workspace: string;
const PROJECT_ID = 'sample-project';
const REPO = 'sample-repo';
const NODE_ID = 'aaaa:function:src/widgets/order.ts:placeOrder';
const CAPTURED = `${NODE_ID}@1111`;

function overlay(): Record<string, unknown> {
  return {
    schemaVersion: 2,
    domains: [
      { id: 'ordering', title: 'Ordering' },
      { id: 'stock', title: 'Stock and warehouses' },
      { id: 'returns', title: 'Returns' },
    ],
    projectId: PROJECT_ID,
    items: [
      {
        id: 'cap-widget-ordering',
        domain: 'ordering',
        kind: 'capability',
        title: 'Widget ordering',
        statement: 'A store operator can order widgets for one warehouse.',
        authority: 'accepted',
        payload: { outcome: 'An order exists', beneficiary: 'Store operator', boundary: 'Single warehouse' },
        sources: [{ kind: 'spec', ref: 'spec/widget-ordering', localId: 'CAP-1' }],
        codeAnchors: [
          {
            repo: REPO,
            nodeId: NODE_ID,
            nodeType: 'function',
            capturedVersionedId: CAPTURED,
            rationale: 'Entry point for ordering',
          },
        ],
      },
      {
        id: 'br-orders-never-exceed-stock',
        domain: 'stock',
        kind: 'business_rule',
        title: 'Orders never exceed stock',
        statement: 'An order beyond available stock is refused.',
        authority: 'accepted',
        payload: {
          condition: 'An order exceeds stock',
          requiredOutcome: 'The order is refused',
          observer: 'Store operator',
        },
        sources: [{ kind: 'issue', ref: 'tracker/WID-14', localId: 'BR-3' }],
      },
      {
        id: 'dec-refuse-over-stock-orders',
        domain: 'stock',
        kind: 'decision',
        title: 'Refuse over-stock orders at submission',
        statement: 'Orders beyond stock are refused at submission.',
        authority: 'candidate',
        payload: {
          question: 'How to handle over-stock?',
          choice: 'Refuse at submission',
          choiceStatus: 'accepted',
          rationale: 'Keeps state consistent',
          alternatives: ['Reconcile later'],
          consequences: ['Operators retry'],
        },
        sources: [{ kind: 'adr', ref: 'docs/adr/0002', localId: 'ADR-2' }],
      },
      {
        id: 'cap-legacy-ordering',
        domain: 'ordering',
        kind: 'capability',
        title: 'Legacy ordering',
        statement: 'Superseded ordering capability.',
        authority: 'superseded',
        payload: { outcome: 'Legacy', beneficiary: 'Store operator', boundary: 'Legacy' },
        sources: [{ kind: 'manual', ref: 'maintainer/notes', localId: 'CAP-OLD' }],
      },
    ],
    relations: [{ from: 'br-orders-never-exceed-stock', type: 'governs', to: 'cap-widget-ordering' }],
  };
}

function writeWorkspace(withOverlay: boolean): void {
  fs.mkdirSync(path.join(workspace, REPO), { recursive: true });
  fs.writeFileSync(
    path.join(workspace, 'coredoc.config.json'),
    JSON.stringify({
      version: '1.0',
      projects: [{ id: PROJECT_ID, name: PROJECT_ID, repos: [{ name: REPO, path: `./${REPO}` }] }],
      output: { dir: './coredoc-output' },
      parserStorage: './coredoc-parsers',
    }),
  );
  if (withOverlay) {
    fs.mkdirSync(path.join(workspace, REPO, '.coredoc'), { recursive: true });
    fs.writeFileSync(path.join(workspace, REPO, '.coredoc', 'intent.json'), JSON.stringify(overlay(), null, 2));
  }
}

function scope(): ScopeContext {
  return {
    currentPath: path.join(workspace, REPO),
    configDir: workspace,
    resolvedRepos: [REPO],
    repoHashes: [generateRepoHash(REPO)],
    project: PROJECT_ID,
    projectId: PROJECT_ID,
    crossRepoEnabled: false,
  };
}

/** Minimal read repository: the two calls anchor evidence makes. */
function fakeRepository(currentVersionedId: string | undefined, graphCommit?: string): IGraphReadRepository {
  return {
    getNodeWithProperties: async (nodeId: string) =>
      nodeId === NODE_ID
        ? {
            node: { id: nodeId, type: 'function', name: 'placeOrder' },
            properties: { versionedId: currentVersionedId },
          }
        : null,
    getRepoOverview: async () =>
      graphCommit ? [{ name: REPO, gitCommitHash: graphCommit, parsedAt: '2026-08-26' }] : [],
  } as unknown as IGraphReadRepository;
}

async function call(
  args: Record<string, unknown>,
  repository?: IGraphReadRepository,
  detailLevel: DetailLevel = 'basic',
): Promise<IntentContextResponse> {
  const response = await handleGetIntentContext(
    args,
    scope(),
    'summary',
    detailLevel,
    resolveDetailLevel(detailLevel),
    repository,
  );
  return response.data as IntentContextResponse;
}

/** The raw tool response, for the paths where `isError` is the contract. */
async function callRaw(args: Record<string, unknown>, repository?: IGraphReadRepository) {
  return handleGetIntentContext(args, scope(), 'summary', 'basic', resolveDetailLevel('basic'), repository);
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'coredoc-mcp-intent-'));
  process.env.MCP_CONFIG_PATH = path.join(workspace, 'coredoc.config.json');
});

afterEach(() => {
  delete process.env.MCP_CONFIG_PATH;
  fs.rmSync(workspace, { recursive: true, force: true });
});

// AC-9 / AC-13
describe('overlay states', () => {
  it('returns not_configured without creating any file when no overlay exists', async () => {
    writeWorkspace(false);
    const data = await call({});
    expect(data.overlayStatus).toBe(IntentOverlayStatus.NotConfigured);
    expect(data.items).toEqual([]);
    expect(fs.existsSync(path.join(workspace, REPO, '.coredoc'))).toBe(false);
  });

  it('returns invalid with actionable paths, distinct from an empty match', async () => {
    writeWorkspace(true);
    const broken = overlay();
    (broken.relations as Record<string, unknown>[])[0] = { from: 'ghost', type: 'governs', to: 'cap-widget-ordering' };
    fs.writeFileSync(path.join(workspace, REPO, '.coredoc', 'intent.json'), JSON.stringify(broken));
    const data = await call({});
    expect(data.overlayStatus).toBe(IntentOverlayStatus.Invalid);
    expect(data.validationErrors?.[0]?.path?.[0]).toBe('relations');
    expect(data.items).toEqual([]);
  });

  it('refuses a pre-migration v1 overlay with the migration remediation, not a crash or partial load (AC-20)', async () => {
    writeWorkspace(true);
    const legacy = {
      schemaVersion: 1,
      projectId: PROJECT_ID,
      items: [
        {
          id: 'CAP-1',
          kind: 'capability',
          title: 'Widget ordering',
          statement: 'A store operator can order widgets for one warehouse.',
          authority: 'accepted',
          payload: { outcome: 'An order exists', beneficiary: 'Store operator', boundary: 'Single warehouse' },
          sources: [{ kind: 'spec', ref: 'spec/widget-ordering', localId: 'CAP-1' }],
        },
      ],
      relations: [],
    };
    fs.writeFileSync(path.join(workspace, REPO, '.coredoc', 'intent.json'), JSON.stringify(legacy));

    const data = await call({}, fakeRepository(CAPTURED));
    expect(data.overlayStatus).toBe(IntentOverlayStatus.Invalid);
    expect(data.validationErrors).toHaveLength(1);
    expect(data.validationErrors?.[0]?.code).toBe(IntentValidationCode.LegacySchemaVersion);
    expect(data.validationErrors?.[0]?.message).toBe(LEGACY_SCHEMA_REMEDIATION);
    expect(data.items).toEqual([]);
  });

  it('returns ready with zero items for a query that matches nothing', async () => {
    writeWorkspace(true);
    const data = await call({ query: 'nothing here matches' }, fakeRepository(CAPTURED));
    expect(data.overlayStatus).toBe(IntentOverlayStatus.Ready);
    expect(data.items).toEqual([]);
    expect(data.totalMatched).toBe(0);
  });
});

// AC-7 / BR-4
describe('authority, anchor status and snapshot freshness are independent', () => {
  it('reports matched anchors against an unverifiable snapshot as matched + unknown', async () => {
    writeWorkspace(true);
    const data = await call({ intentIds: ['cap-widget-ordering'] }, fakeRepository(CAPTURED, 'commit-from-graph'));
    const item = data.items[0];
    expect(item.authority).toBe('accepted');
    // The two dimensions stay independent — anchor status on the item, repo
    // freshness on the single per-repo surface — and neither collapses.
    expect(item.codeAnchors[0].anchorStatus).toBe(AnchorStatus.Matched);
    expect(data.repoSnapshots[0].snapshotFreshness).toBe(SnapshotFreshness.Unknown);
    expect(JSON.stringify(data)).not.toMatch(/unaffected/i);
  });

  it('reports freshness once, on the repo snapshot, never repeated per anchor', async () => {
    writeWorkspace(true);
    const data = await call({ intentIds: ['cap-widget-ordering'] }, fakeRepository(CAPTURED, 'commit-from-graph'));
    expect(data.repoSnapshots).toHaveLength(1);
    expect(data.repoSnapshots[0].snapshotFreshness).toBe(SnapshotFreshness.Unknown);
    expect(Object.keys(data.items[0].codeAnchors[0])).not.toContain('snapshotFreshness');
  });

  it('truncates snapshot commits to a short prefix', async () => {
    writeWorkspace(true);
    const data = await call(
      { intentIds: ['cap-widget-ordering'] },
      fakeRepository(CAPTURED, '0123456789abcdef0123456789abcdef01234567'),
    );
    expect(data.repoSnapshots[0].graphCommit).toBe('0123456789ab');
  });

  it('reports a drifted anchor as changed while keeping the intent', async () => {
    writeWorkspace(true);
    const data = await call(
      { intentIds: ['cap-widget-ordering'] },
      fakeRepository(`${NODE_ID}@9999`, 'commit-from-graph'),
    );
    expect(data.items[0].codeAnchors[0].anchorStatus).toBe(AnchorStatus.Changed);
    expect(data.items[0].id).toBe('cap-widget-ordering');
  });

  it('reports two anchors on the SAME node with different captured ids independently (never one status for both)', async () => {
    writeWorkspace(false);
    const twoAnchorItem = {
      ...overlay(),
      relations: [],
      items: [
        {
          ...(overlay().items as Record<string, unknown>[])[0],
          codeAnchors: [
            {
              repo: REPO,
              nodeId: NODE_ID,
              nodeType: 'function',
              capturedVersionedId: CAPTURED,
              rationale: 'Original capture — should read as matched',
            },
            {
              repo: REPO,
              nodeId: NODE_ID,
              nodeType: 'function',
              capturedVersionedId: `${NODE_ID}@9999`,
              rationale: 'Stale capture on the same node — should read as changed',
            },
          ],
        },
      ],
    };
    fs.mkdirSync(path.join(workspace, REPO, '.coredoc'), { recursive: true });
    fs.writeFileSync(path.join(workspace, REPO, '.coredoc', 'intent.json'), JSON.stringify(twoAnchorItem, null, 2));

    const data = await call({ intentIds: ['cap-widget-ordering'] }, fakeRepository(CAPTURED));
    const anchors = data.items[0].codeAnchors;
    expect(anchors).toHaveLength(2);
    // Positional, distinguished by the stored rationale: the captured ids the
    // two anchors differ by are no longer part of the response.
    expect(anchors[0].rationale).toContain('Original capture');
    expect(anchors[0].anchorStatus).toBe(AnchorStatus.Matched);
    expect(anchors[1].rationale).toContain('Stale capture');
    expect(anchors[1].anchorStatus).toBe(AnchorStatus.Changed);
  });

  it('marks an item with no anchors as unmapped, never as matched', async () => {
    writeWorkspace(true);
    const data = await call({ intentIds: ['br-orders-never-exceed-stock'] }, fakeRepository(CAPTURED));
    expect(data.items[0].itemStatus).toBe(AnchorStatus.Unmapped);
    expect(data.items[0].codeAnchors).toEqual([]);
  });

  it('carries the short anchor caveat exactly when the response returns an anchor', async () => {
    writeWorkspace(true);
    const withAnchor = await call({ intentIds: ['cap-widget-ordering'] }, fakeRepository(CAPTURED));
    expect(withAnchor.items[0].codeAnchors.length).toBeGreaterThan(0);
    expect(withAnchor.warning).toBe(INTENT_ANCHOR_WARNING_COMPACT);
    expect(withAnchor.warning?.length).toBeLessThan(120);

    // An anchorless item has nothing to caveat, so the caveat is not paid for.
    const anchorless = await call({ intentIds: ['br-orders-never-exceed-stock'] }, fakeRepository(CAPTURED));
    expect(anchorless.items[0].codeAnchors).toEqual([]);
    expect(anchorless.warning).toBeUndefined();

    writeWorkspace(false);
    fs.rmSync(path.join(workspace, REPO, '.coredoc'), { recursive: true, force: true });
    expect((await call({})).warning).toBeUndefined();
  });
});

// Response budget: the compact shape an agent pays for on every call.
describe('response shape', () => {
  it('never names the overlay file, in either mode or any overlay state', async () => {
    writeWorkspace(true);
    const ready = await call({ intentIds: ['cap-widget-ordering'] }, fakeRepository(CAPTURED));
    expect(ready).not.toHaveProperty('intentPath');
    expect(JSON.stringify(ready)).not.toContain('intent.json');

    const list = (await callRaw({ mode: 'list' })).data as IntentIndexResponse;
    expect(list).not.toHaveProperty('intentPath');
    expect(JSON.stringify(list)).not.toContain('intent.json');

    writeWorkspace(false);
    fs.rmSync(path.join(workspace, REPO, '.coredoc'), { recursive: true, force: true });
    const absent = await call({});
    expect(absent).not.toHaveProperty('intentPath');
    expect(JSON.stringify(absent)).not.toContain('intent.json');
  });

  it('returns anchors without either versioned id', async () => {
    writeWorkspace(true);
    const data = await call({ intentIds: ['cap-widget-ordering'] }, fakeRepository(`${NODE_ID}@9999`));
    const anchor = data.items[0].codeAnchors[0];
    expect(Object.keys(anchor).sort()).toEqual(['anchorStatus', 'nodeId', 'nodeType', 'rationale', 'repo']);
    expect(JSON.stringify(data)).not.toContain('@1111');
    expect(JSON.stringify(data)).not.toContain('@9999');
  });

  it('omits truncation, unknown-id and evidence fields when they carry no information', async () => {
    writeWorkspace(true);
    const data = await call({ intentIds: ['cap-widget-ordering'] }, fakeRepository(CAPTURED));
    for (const key of [
      'truncated',
      'omittedCount',
      'relationsTruncated',
      'omittedRelationCount',
      'unknownIntentIds',
      'evidence',
    ]) {
      expect(data).not.toHaveProperty(key);
    }
  });

  it('emits those fields when they DO carry information', async () => {
    writeWorkspace(true);
    const truncated = await call({ includeCandidates: true, limit: 1 }, fakeRepository(CAPTURED));
    expect(truncated.truncated).toBe(true);
    expect(truncated.omittedCount).toBe(2);

    const unknown = await call({ intentIds: ['cap-widget-ordering', 'ghost'] }, fakeRepository(CAPTURED));
    expect(unknown.unknownIntentIds).toEqual(['ghost']);

    const noGraph = await call({ intentIds: ['cap-widget-ordering'] }, undefined);
    expect(noGraph.evidence?.available).toBe(false);
    expect(noGraph.evidence?.reason).toContain('No local graph');
  });

  it('omits matchReason for an exact-id fetch but reports it for a discovered match', async () => {
    writeWorkspace(true);
    const exact = await call({ intentIds: ['cap-widget-ordering'] }, fakeRepository(CAPTURED));
    expect(exact.items[0]).not.toHaveProperty('matchReason');

    const searched = await call({ query: 'widget' }, fakeRepository(CAPTURED));
    expect(searched.items[0].matchReason).toBe('text');

    const byNode = await call({ nodeIds: [NODE_ID] }, fakeRepository(CAPTURED));
    expect(byNode.items[0].matchReason).toBe('node_anchor');
  });
});

// AC-9 — an unavailable graph never turns into an error or a missing anchor
describe('graph unavailable', () => {
  it('returns intent with evidence explicitly unavailable when no repository is bound', async () => {
    writeWorkspace(true);
    const data = await call({ intentIds: ['cap-widget-ordering'] }, undefined);
    expect(data.overlayStatus).toBe(IntentOverlayStatus.Ready);
    expect(data.items[0].id).toBe('cap-widget-ordering');
    expect(data.evidence?.available).toBe(false);
    expect(data.items[0].codeAnchors[0].nodeId).toBe(NODE_ID);
    expect(data.items[0].codeAnchors[0].anchorStatus).toBeUndefined();
    expect(data.repoSnapshots).toEqual([]);
  });

  it('does not fail the call when the graph read throws', async () => {
    writeWorkspace(true);
    const broken = {
      getNodeWithProperties: async () => {
        throw new Error('database is locked');
      },
      getRepoOverview: async () => {
        throw new Error('database is locked');
      },
    } as unknown as IGraphReadRepository;
    const data = await call({ intentIds: ['cap-widget-ordering'] }, broken);
    expect(data.evidence?.available).toBe(false);
    expect(data.evidence?.reason).toContain('database is locked');
    expect(data.items[0].id).toBe('cap-widget-ordering');
  });
});

// AC-8 / BR-13
describe('authority filtering, ordering and truncation', () => {
  it('defaults to accepted items, opts in to candidates, and reaches superseded only by exact id', async () => {
    writeWorkspace(true);
    const repository = fakeRepository(CAPTURED);

    const defaults = await call({}, repository);
    expect(defaults.items.map((item) => item.id)).toEqual(['br-orders-never-exceed-stock', 'cap-widget-ordering']);

    const withCandidates = await call({ includeCandidates: true }, repository);
    expect(withCandidates.items.map((item) => item.id)).toEqual([
      'br-orders-never-exceed-stock',
      'cap-widget-ordering',
      'dec-refuse-over-stock-orders',
    ]);

    const byExactId = await call({ intentIds: ['cap-legacy-ordering'] }, repository);
    expect(byExactId.items.map((item) => item.id)).toEqual(['cap-legacy-ordering']);
    expect(byExactId.items[0].authority).toBe('superseded');
  });

  it('reports truncation with the omitted count', async () => {
    writeWorkspace(true);
    const data = await call({ includeCandidates: true, limit: 1 }, fakeRepository(CAPTURED));
    expect(data.items).toHaveLength(1);
    expect(data.truncated).toBe(true);
    expect(data.omittedCount).toBe(2);
    expect(data.limit).toBe(1);
  });

  it('returns one-hop relations for the returned items', async () => {
    writeWorkspace(true);
    const data = await call({ intentIds: ['cap-widget-ordering'] }, fakeRepository(CAPTURED));
    expect(data.relations).toEqual([
      { from: 'br-orders-never-exceed-stock', type: 'governs', to: 'cap-widget-ordering' },
    ]);
  });

  it('reports requested ids that do not exist', async () => {
    writeWorkspace(true);
    const data = await call({ intentIds: ['ghost'] }, fakeRepository(CAPTURED));
    expect(data.unknownIntentIds).toEqual(['ghost']);
    expect(data.items).toEqual([]);
  });
});

// AC-16 / BR-20 — the domain filter on the tool contract
describe('domain filtering', () => {
  it('reports each item domain in the response', async () => {
    writeWorkspace(true);
    const data = await call(
      { intentIds: ['cap-widget-ordering', 'br-orders-never-exceed-stock'] },
      fakeRepository(CAPTURED),
    );
    expect(data.items.map((item) => item.domain)).toEqual(['ordering', 'stock']);
  });

  it('returns only the requested domain and composes with a query', async () => {
    writeWorkspace(true);
    const repository = fakeRepository(CAPTURED);

    const filtered = await call({ domain: 'stock' }, repository);
    expect(filtered.items.map((item) => item.id)).toEqual(['br-orders-never-exceed-stock']);

    const composed = await call({ domain: 'ordering', query: 'widget' }, repository);
    expect(composed.items.map((item) => item.id)).toEqual(['cap-widget-ordering']);
  });

  it('never filters exact intentIds by domain', async () => {
    writeWorkspace(true);
    const data = await call({ domain: 'stock', intentIds: ['cap-widget-ordering'] }, fakeRepository(CAPTURED));
    expect(data.items.map((item) => item.id)).toEqual(['cap-widget-ordering']);
  });

  it('distinguishes a declared-but-empty domain from an undeclared one', async () => {
    writeWorkspace(true);
    const empty = await callRaw({ domain: 'returns' }, fakeRepository(CAPTURED));
    expect(empty.isError).toBeUndefined();
    expect((empty.data as IntentContextResponse).items).toEqual([]);

    const unknown = await callRaw({ domain: 'payments' }, fakeRepository(CAPTURED));
    expect(unknown.isError).toBe(true);
    expect(unknown.data).toContain('payments');
    expect(unknown.data).toContain('ordering, stock, returns');
  });

  it('refuses a non-string domain as a request error instead of silently returning the unfiltered set (BR-20)', async () => {
    writeWorkspace(true);
    const numeric = await callRaw({ domain: 123 }, fakeRepository(CAPTURED));
    expect(numeric.isError).toBe(true);
    expect(numeric.data).toContain('must be a string');
    expect(numeric.data).toContain('ordering, stock, returns');

    const array = await callRaw({ domain: ['ordering'] }, fakeRepository(CAPTURED));
    expect(array.isError).toBe(true);
    expect(array.data).toContain('must be a string');
  });
});

describe('detail level', () => {
  it('omits the typed payload at basic detail and includes it at full', async () => {
    writeWorkspace(true);
    const compact = await call({ intentIds: ['cap-widget-ordering'] }, fakeRepository(CAPTURED), 'basic');
    expect(compact.items[0].payload).toBeUndefined();
    expect(compact.items[0].statement).toContain('store operator');

    const full = await call({ intentIds: ['cap-widget-ordering'] }, fakeRepository(CAPTURED), 'full');
    expect(full.items[0].payload).toMatchObject({ beneficiary: 'Store operator' });
  });

  it('matches items by anchored code node id', async () => {
    writeWorkspace(true);
    const data = await call({ nodeIds: [NODE_ID] }, fakeRepository(CAPTURED));
    expect(data.items.map((item) => item.id)).toEqual(['cap-widget-ordering']);
  });
});

// Real-wiring: a real sqlite project graph (not `fakeRepository`) passed as
// the tool's `repository` argument, the same seam `server.ts` wires from
// `openProjectDatabase` in production.
describe('handleGetIntentContext (real sqlite backend)', () => {
  afterEach(async () => {
    await closeProjectDatabases();
  });

  it('resolves a matched anchor against a real pushed graph node', async () => {
    writeWorkspace(false);
    const repoHash = generateRepoHash(REPO);
    const realNodeId = `${repoHash}:function:src/widgets/order.ts:placeOrder`;
    const versionedId = `${realNodeId}@1111`;

    const node: GraphNode = {
      id: realNodeId,
      type: NodeType.Function,
      name: 'placeOrder',
      repoId: repoHash,
      filePath: 'src/widgets/order.ts',
      startLine: 1,
      endLine: 5,
      properties: { versionedId },
    } as GraphNode;
    const project = await openProjectDatabase(workspace, PROJECT_ID);
    await project.graph.pushNodes([node]);

    fs.mkdirSync(path.join(workspace, REPO, '.coredoc'), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, REPO, '.coredoc', 'intent.json'),
      JSON.stringify(
        {
          schemaVersion: 2,
          domains: [{ id: 'ordering', title: 'Ordering' }],
          projectId: PROJECT_ID,
          items: [
            {
              id: 'cap-widget-ordering',
              domain: 'ordering',
              kind: 'capability',
              title: 'Widget ordering',
              statement: 'A store operator can order widgets for one warehouse.',
              authority: 'accepted',
              payload: { outcome: 'An order exists', beneficiary: 'Store operator', boundary: 'Single warehouse' },
              sources: [{ kind: 'spec', ref: 'spec/widget-ordering', localId: 'CAP-1' }],
              codeAnchors: [
                {
                  repo: REPO,
                  nodeId: realNodeId,
                  nodeType: 'function',
                  capturedVersionedId: versionedId,
                  rationale: 'Entry point for ordering',
                },
              ],
            },
          ],
          relations: [],
        },
        null,
        2,
      ),
    );

    const data = await call({ intentIds: ['cap-widget-ordering'] }, project.graph);
    // Available evidence is reported by the anchor status itself; the
    // `evidence` field appears only when resolution FAILED.
    expect(data.evidence).toBeUndefined();
    expect(data.items[0]?.codeAnchors[0]?.anchorStatus).toBe(AnchorStatus.Matched);
  });
});

// AC-8 — relation-truncation metadata must survive the surface contract
describe('relation truncation metadata', () => {
  it('reports relationsTruncated and omittedRelationCount when one-hop relations exceed the cap', async () => {
    writeWorkspace(false);
    const spokes = Array.from({ length: 60 }, (_, i) => ({
      id: `cap-s${i}`,
      domain: 'ordering',
      kind: 'capability',
      title: `Spoke ${i}`,
      statement: 'Spoke capability.',
      authority: 'accepted',
      payload: { outcome: 'Outcome', beneficiary: 'Operator', boundary: 'Bounded' },
      sources: [{ kind: 'spec', ref: 'spec/hub', localId: `CAP-S${i}` }],
    }));
    const file = {
      schemaVersion: 2,
      domains: [{ id: 'ordering', title: 'Ordering' }],
      projectId: PROJECT_ID,
      items: [
        {
          id: 'cap-hub',
          domain: 'ordering',
          kind: 'capability',
          title: 'Hub',
          statement: 'Hub capability.',
          authority: 'accepted',
          payload: { outcome: 'Outcome', beneficiary: 'Operator', boundary: 'Bounded' },
          sources: [{ kind: 'spec', ref: 'spec/hub', localId: 'cap-hub' }],
        },
        ...spokes,
      ],
      relations: spokes.map((spoke) => ({ from: spoke.id, type: 'depends_on', to: 'cap-hub' })),
    };
    fs.mkdirSync(path.join(workspace, REPO, '.coredoc'), { recursive: true });
    fs.writeFileSync(path.join(workspace, REPO, '.coredoc', 'intent.json'), JSON.stringify(file, null, 2));

    const data = await call({ intentIds: ['cap-hub'] });
    expect(data.relations).toHaveLength(50);
    expect(data.relationsTruncated).toBe(true);
    expect(data.omittedRelationCount).toBe(10);
  });
});

// AC-21 / AC-23 — list mode over the SAME tool (BR-28: no new tool).
describe('list mode', () => {
  async function callList(args: Record<string, unknown> = {}): Promise<IntentIndexResponse> {
    return (await callRaw({ mode: 'list', ...args })).data as IntentIndexResponse;
  }

  it('returns the declared registry plus payload-free entries', async () => {
    writeWorkspace(true);
    const data = await callList();

    expect(data.mode).toBe('list');
    expect(data.overlayStatus).toBe(IntentOverlayStatus.Ready);
    expect(data.domains).toEqual([
      { id: 'ordering', title: 'Ordering' },
      { id: 'stock', title: 'Stock and warehouses' },
      { id: 'returns', title: 'Returns' },
    ]);
    expect(data.entries).toEqual([
      {
        id: 'cap-widget-ordering',
        title: 'Widget ordering',
        kind: 'capability',
        domain: 'ordering',
        authority: 'accepted',
      },
      {
        id: 'br-orders-never-exceed-stock',
        title: 'Orders never exceed stock',
        kind: 'business_rule',
        domain: 'stock',
        authority: 'accepted',
      },
    ]);
    expect(data.ids).toBeUndefined();
    expect(data.truncated).toBe(false);
    expect(data.totalMatched).toBe(2);
    expect(JSON.stringify(data)).not.toContain('beneficiary');
  });

  it('returns bare slug ids at format "ids"', async () => {
    writeWorkspace(true);
    const data = await callList({ format: 'ids', includeCandidates: true });
    expect(data.ids).toEqual(['cap-widget-ordering', 'br-orders-never-exceed-stock', 'dec-refuse-over-stock-orders']);
    expect(data.entries).toBeUndefined();
    expect(data.domains).toHaveLength(3);
  });

  it('composes domain and kind, and never lists superseded or rejected items', async () => {
    writeWorkspace(true);
    expect((await callList({ domain: 'stock', includeCandidates: true })).entries?.map((e) => e.id)).toEqual([
      'br-orders-never-exceed-stock',
      'dec-refuse-over-stock-orders',
    ]);
    expect(
      (await callList({ domain: 'stock', kind: 'decision', includeCandidates: true })).entries?.map((e) => e.id),
    ).toEqual(['dec-refuse-over-stock-orders']);
    // `cap-legacy-ordering` is superseded — exact-ID-only, in either mode (BR-13/BR-25).
    const everything = await callList({ includeCandidates: true, format: 'ids' });
    expect(everything.ids).not.toContain('cap-legacy-ordering');
  });

  // An agent that derives `nodeIds` from a diff and finds nothing anchored is
  // asking the NARROWEST possible question. Collapsing `[]` to "no selector"
  // answered it with the whole default accepted set — the widest possible answer,
  // with `matchReason: "default"` as the only hint that it had happened.
  it('treats an explicitly empty selector as a selector that matched nothing', async () => {
    writeWorkspace(true);

    const withNone = await call({ nodeIds: [] });
    expect(withNone.items).toHaveLength(0);

    const withEmptyIds = await call({ intentIds: [] });
    expect(withEmptyIds.items).toHaveLength(0);

    // …and the no-selector default is unchanged: absent still means "give me the
    // accepted set", which is a different request from "match these zero nodes".
    const withNoSelector = await call({});
    expect(withNoSelector.items.length).toBeGreaterThan(0);
  });

  it('rejects context-mode selectors with an actionable error (BR-28)', async () => {
    writeWorkspace(true);
    for (const selector of [{ intentIds: ['cap-widget-ordering'] }, { nodeIds: [NODE_ID] }, { query: 'widget' }]) {
      const response = await callRaw({ mode: 'list', ...selector });
      expect(response.isError).toBe(true);
      expect(String(response.data)).toContain('Invalid arguments for mode "list"');
      expect(String(response.data)).toContain('mode "context"');
    }
  });

  it('rejects list-only arguments in context mode (BR-28)', async () => {
    writeWorkspace(true);
    const response = await callRaw({ kind: 'decision' });
    expect(response.isError).toBe(true);
    expect(String(response.data)).toContain('Invalid arguments for mode "context"');
    expect(String(response.data)).toContain('mode "list"');
  });

  it('rejects an unknown mode and an unknown list format', async () => {
    writeWorkspace(true);
    const badMode = await callRaw({ mode: 'browse' });
    expect(badMode.isError).toBe(true);
    expect(String(badMode.data)).toContain('Valid modes: context, list');

    const badFormat = await callRaw({ mode: 'list', format: 'raw' });
    expect(badFormat.isError).toBe(true);
    expect(String(badFormat.data)).toContain('Valid formats: index, ids');
  });

  it('errors on an undeclared domain or unknown kind instead of answering empty', async () => {
    writeWorkspace(true);
    const domain = await callRaw({ mode: 'list', domain: 'payments' });
    expect(domain.isError).toBe(true);
    expect(String(domain.data)).toContain('declared domains: ordering, stock, returns');

    const kind = await callRaw({ mode: 'list', kind: 'note' });
    expect(kind.isError).toBe(true);
    expect(String(kind.data)).toContain('valid kinds: capability, use_case, flow, business_rule, limitation, decision');

    const nonString = await callRaw({ mode: 'list', kind: 7 });
    expect(nonString.isError).toBe(true);
    expect(String(nonString.data)).toContain('intent kind must be a string');

    const emptyButDeclared = (await callRaw({ mode: 'list', domain: 'returns' })).data as IntentIndexResponse;
    expect(emptyButDeclared.entries).toEqual([]);
    expect(emptyButDeclared.totalMatched).toBe(0);
  });

  it('refuses a present-but-wrong-type selector instead of widening to the full accepted set (BR-28)', async () => {
    writeWorkspace(true);
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ intentIds: [123] }, 'intent selector `intentIds` must be an array of strings'],
      [{ intentIds: 'cap-widget-ordering' }, 'intent selector `intentIds` must be an array of strings'],
      [{ nodeIds: 'x' }, 'intent selector `nodeIds` must be an array of strings'],
      [{ query: 42 }, 'intent selector `query` must be a string'],
      [{ limit: '10' }, 'intent selector `limit` must be a number'],
      [{ includeCandidates: 'true' }, 'intent selector `includeCandidates` must be a boolean'],
    ];
    for (const [selector, message] of cases) {
      const response = await callRaw(selector);
      expect(response.isError).toBe(true);
      expect(String(response.data)).toContain(message);
    }
  });

  it('rejects `limit` in list mode rather than silently ignoring it (BR-28)', async () => {
    writeWorkspace(true);
    const response = await callRaw({ mode: 'list', limit: 50 });
    expect(response.isError).toBe(true);
    expect(String(response.data)).toContain('Invalid arguments for mode "list"');
  });

  it('keeps absent and invalid overlays non-error states in list mode too (BR-9)', async () => {
    writeWorkspace(false);
    const absent = await callRaw({ mode: 'list' });
    expect(absent.isError).toBeUndefined();
    expect((absent.data as IntentIndexResponse).overlayStatus).toBe(IntentOverlayStatus.NotConfigured);
    expect((absent.data as IntentIndexResponse).domains).toEqual([]);
    expect(fs.existsSync(path.join(workspace, REPO, '.coredoc'))).toBe(false);

    writeWorkspace(true);
    const broken = overlay();
    (broken.relations as Record<string, unknown>[])[0] = { from: 'ghost', type: 'governs', to: 'cap-widget-ordering' };
    fs.writeFileSync(path.join(workspace, REPO, '.coredoc', 'intent.json'), JSON.stringify(broken));
    const invalid = await callRaw({ mode: 'list' });
    expect(invalid.isError).toBeUndefined();
    expect((invalid.data as IntentIndexResponse).overlayStatus).toBe(IntentOverlayStatus.Invalid);
    expect((invalid.data as IntentIndexResponse).validationErrors?.[0]?.path?.[0]).toBe('relations');
  });
});

// AC-23 — the default mode is byte-identical to the pre-list contract.
describe('context mode is unchanged by the list surface (AC-23)', () => {
  it('answers an existing request identically with and without an explicit mode', async () => {
    writeWorkspace(true);
    for (const args of [
      {},
      { query: 'widget' },
      { intentIds: ['cap-legacy-ordering'] },
      { domain: 'stock', includeCandidates: true },
      { nodeIds: [NODE_ID] },
    ]) {
      const implicit = await callRaw(args, fakeRepository(CAPTURED, 'abc123'));
      const explicit = await callRaw({ ...args, mode: 'context' }, fakeRepository(CAPTURED, 'abc123'));
      expect(JSON.stringify(explicit.data)).toBe(JSON.stringify(implicit.data));
      expect(implicit.isError).toBeUndefined();
      expect(JSON.stringify(implicit.data)).not.toContain('"mode"');
    }
  });
});

// AC-8 / LIM-1 — a cut-over project is not a local read surface.
describe('after cloud cutover', () => {
  it.each([
    {},
    { mode: 'context', query: 'widget' },
    { mode: 'list' },
  ])('refuses %j, names the workspace, and returns no items', async (args) => {
    writeWorkspace(true);
    const configPath = path.join(workspace, 'coredoc.config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    config.projects[0].intent = { mode: 'cloud', workspaceId: 'ws-cloud-42' };
    fs.writeFileSync(configPath, JSON.stringify(config));

    const response = await callRaw(args);
    expect(response.isError).toBe(true);
    expect(typeof response.data).toBe('string');
    expect(response.data).toContain('ws-cloud-42');
    expect(response.data).toContain('workspace MCP');
    expect(response.data).not.toContain('cap-widget-ordering');
  });
});
