import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  IntentAuthority,
  IntentCaptureError,
  IntentOverlayInvalidError,
  IntentOverlayStatus,
  IntentMatchReason,
  IntentProposalsInvalidError,
  IntentValidationCode,
  LEGACY_SCHEMA_REMEDIATION,
  MAX_INTENT_FILE_BYTES,
  repoHashesForProject,
  type IntentKind,
} from '@coredoc/core';
import type { RuntimeConfig } from '@coredoc/core/types';
import { AnchorStatus, NodeType, SnapshotFreshness, closeProjectDatabases, openProjectDatabase } from '@coredoc/db';
import type { GraphNode, IntentEvidenceResult } from '@coredoc/db';
import { loadConfig } from '../sdk/config.js';
import {
  INTENT_ANCHOR_WARNING,
  createGraphEvidenceResolver,
  resolveIntentTarget,
  printCaptureResult,
  printContextResult,
  printListResult,
  printStatusResult,
  printValidateResult,
  runIntentCapture,
  runIntentContext,
  runIntentList,
  runIntentStatus,
  runIntentValidate,
} from './intent.js';

let workspace: string;

const ANCHOR_NODE_ID = 'aaaa:function:src/widgets/order.ts:placeOrder';

function intentFileJson(projectId: string): Record<string, unknown> {
  return {
    schemaVersion: 2,
    projectId,
    domains: [
      { id: 'ordering', title: 'Ordering' },
      { id: 'stock', title: 'Stock and warehouses' },
      { id: 'returns', title: 'Returns', statement: 'Declared, not yet populated.' },
    ],
    items: [
      {
        id: 'cap-widget-ordering',
        domain: 'ordering',
        kind: 'capability',
        title: 'Widget ordering',
        statement: 'A store operator can order widgets for one warehouse.',
        authority: 'accepted',
        payload: {
          outcome: 'An operator places a widget order',
          beneficiary: 'Store operator',
          boundary: 'Single warehouse',
        },
        sources: [{ kind: 'spec', ref: 'spec/widget-ordering', localId: 'CAP-1' }],
        codeAnchors: [
          {
            repo: 'sample-repo',
            nodeId: ANCHOR_NODE_ID,
            nodeType: 'function',
            capturedVersionedId: `${ANCHOR_NODE_ID}@1111`,
            rationale: 'Entry point that performs the ordering outcome',
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
          condition: 'An order requests more units than the warehouse holds',
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
          question: 'How should over-stock orders be handled?',
          choice: 'Refuse at submission time',
          choiceStatus: 'accepted',
          rationale: 'Keeps stock and order state consistent',
          alternatives: ['Reconcile later'],
          consequences: ['Operators retry after restock'],
        },
        sources: [{ kind: 'adr', ref: 'docs/adr/0002', localId: 'ADR-2' }],
      },
    ],
    relations: [
      { from: 'br-orders-never-exceed-stock', type: 'governs', to: 'cap-widget-ordering' },
      { from: 'dec-refuse-over-stock-orders', type: 'decides', to: 'br-orders-never-exceed-stock' },
    ],
  };
}

/** Config with one project; `repoNames` become sibling repo dirs under the workspace. */
function writeWorkspace(repoNames: string[] = ['sample-repo'], projectId = 'sample-project'): RuntimeConfig {
  const configPath = path.join(workspace, 'coredoc.config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      version: '1.0',
      projects: [
        {
          id: projectId,
          name: projectId,
          repos: repoNames.map((name) => ({ name, path: `./${name}` })),
        },
      ],
      output: { dir: './coredoc-output' },
      parserStorage: './coredoc-parsers',
    }),
  );
  for (const name of repoNames) fs.mkdirSync(path.join(workspace, name), { recursive: true });
  return loadConfig(configPath, { skipMigration: true });
}

function writeIntentFile(repoName: string, value: unknown): string {
  const dir = path.join(workspace, repoName, '.coredoc');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'intent.json');
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
  return filePath;
}

function evidenceFor(
  status: AnchorStatus.Matched | AnchorStatus.Changed | AnchorStatus.Missing,
  freshness: SnapshotFreshness,
) {
  return async (): Promise<IntentEvidenceResult> => ({
    items: [
      {
        intentId: 'cap-widget-ordering',
        anchors: [
          {
            anchor: {
              repo: 'sample-repo',
              nodeId: ANCHOR_NODE_ID,
              nodeType: 'function' as never,
              capturedVersionedId: `${ANCHOR_NODE_ID}@1111`,
              rationale: 'Entry point that performs the ordering outcome',
            },
            status,
            snapshotFreshness: freshness,
          },
        ],
      },
      { intentId: 'br-orders-never-exceed-stock', anchors: [], itemStatus: AnchorStatus.Unmapped },
      { intentId: 'dec-refuse-over-stock-orders', anchors: [], itemStatus: AnchorStatus.Unmapped },
    ],
    repos: [{ repo: 'sample-repo', repoHash: 'aaaa', snapshotFreshness: freshness }],
  });
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'coredoc-cli-intent-'));
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('resolveIntentTarget', () => {
  it('resolves the single repo of a pilot project (LIM-7)', () => {
    const config = writeWorkspace();
    const target = resolveIntentTarget(config, 'sample-project');
    expect(target.repoName).toBe('sample-repo');
    expect(target.repoRoot).toBe(path.join(workspace, 'sample-repo'));
    expect(target.intentPath).toBe(path.join(workspace, 'sample-repo', '.coredoc', 'intent.json'));
  });

  it('picks the repo that owns the overlay when a project has several repos', () => {
    const config = writeWorkspace(['api', 'web']);
    writeIntentFile('web', intentFileJson('sample-project'));
    expect(resolveIntentTarget(config, 'sample-project').repoName).toBe('web');
  });

  it('errors explicitly when several repos of a project carry an overlay', () => {
    const config = writeWorkspace(['api', 'web']);
    writeIntentFile('api', intentFileJson('sample-project'));
    writeIntentFile('web', intentFileJson('sample-project'));
    expect(() => resolveIntentTarget(config, 'sample-project')).toThrow(/ambiguous/i);
  });

  it('errors explicitly when a multi-repo project has no overlay anywhere', () => {
    const config = writeWorkspace(['api', 'web']);
    expect(() => resolveIntentTarget(config, 'sample-project')).toThrow(/single-repo/i);
  });

  it('errors when the project is unknown', () => {
    const config = writeWorkspace();
    expect(() => resolveIntentTarget(config, 'ghost')).toThrow(/ghost/);
  });
});

// AC-9 — absent / invalid / no-match / graph-unavailable are DISTINCT results.
describe('runIntentValidate (AC-9, AC-2)', () => {
  it('reports not_configured for an absent overlay and does not create it', () => {
    const config = writeWorkspace();
    const result = runIntentValidate({ config, projectId: 'sample-project' });
    expect(result.status).toBe(IntentOverlayStatus.NotConfigured);
    expect(fs.existsSync(result.intentPath)).toBe(false);
  });

  it('reports ready with counts for a valid overlay', () => {
    const config = writeWorkspace();
    writeIntentFile('sample-repo', intentFileJson('sample-project'));
    const result = runIntentValidate({ config, projectId: 'sample-project' });
    expect(result.status).toBe(IntentOverlayStatus.Ready);
    expect(result.counts).toMatchObject({
      items: 3,
      relations: 2,
      byAuthority: { [IntentAuthority.Accepted]: 2, [IntentAuthority.Candidate]: 1 },
    });
  });

  it('reports invalid with actionable paths, distinct from no matches', () => {
    const config = writeWorkspace();
    const broken = intentFileJson('sample-project');
    (broken.relations as Record<string, unknown>[])[0] = { from: 'GHOST', type: 'governs', to: 'cap-widget-ordering' };
    writeIntentFile('sample-repo', broken);
    const result = runIntentValidate({ config, projectId: 'sample-project' });
    expect(result.status).toBe(IntentOverlayStatus.Invalid);
    expect(result.errors?.[0]?.path?.[0]).toBe('relations');
    expect(result.message).toContain('relations');
  });

  it('rejects an overlay whose projectId does not match the resolving project (BR-12)', () => {
    const config = writeWorkspace();
    writeIntentFile('sample-repo', intentFileJson('other-project'));
    const result = runIntentValidate({ config, projectId: 'sample-project' });
    expect(result.status).toBe(IntentOverlayStatus.Invalid);
  });
});

describe('runIntentStatus (AC-7, AC-9)', () => {
  it('reports counts plus repo freshness when the graph is available', async () => {
    const config = writeWorkspace();
    writeIntentFile('sample-repo', intentFileJson('sample-project'));
    const result = await runIntentStatus({
      config,
      projectId: 'sample-project',
      resolveEvidence: evidenceFor(AnchorStatus.Matched, SnapshotFreshness.Stale),
    });
    expect(result.status).toBe(IntentOverlayStatus.Ready);
    expect(result.evidence.available).toBe(true);
    expect(result.anchorCounts?.[AnchorStatus.Matched]).toBe(1);
    // Anchor-status histogram is ANCHORS only — the two unmapped items from
    // the fixture (BR-1, DEC-1) must not leak into it as a fake `unmapped`
    // anchor count, and must be reported as their own unit instead.
    expect(result.anchorCounts?.[AnchorStatus.Unmapped as never]).toBeUndefined();
    expect(result.unanchoredItems).toBe(2);
    expect(result.repos?.[0]?.snapshotFreshness).toBe(SnapshotFreshness.Stale);
  });

  it('still reports the overlay when the graph is unavailable, with freshness unknown', async () => {
    const config = writeWorkspace();
    writeIntentFile('sample-repo', intentFileJson('sample-project'));
    const result = await runIntentStatus({
      config,
      projectId: 'sample-project',
      resolveEvidence: async () => {
        throw new Error('no graph data for project "sample-project"');
      },
    });
    expect(result.status).toBe(IntentOverlayStatus.Ready);
    expect(result.counts?.items).toBe(3);
    expect(result.evidence.available).toBe(false);
    expect(result.evidence.reason).toContain('no graph data');
    expect(result.anchorCounts).toBeUndefined();
    expect(result.unanchoredItems).toBeUndefined();
    expect(result.repos).toBeUndefined();
  });

  it('reports not_configured without touching the graph', async () => {
    const config = writeWorkspace();
    let called = false;
    const result = await runIntentStatus({
      config,
      projectId: 'sample-project',
      resolveEvidence: async () => {
        called = true;
        throw new Error('should not be called');
      },
    });
    expect(result.status).toBe(IntentOverlayStatus.NotConfigured);
    expect(called).toBe(false);
  });
});

describe('runIntentContext (AC-7, AC-8, AC-9)', () => {
  it('carries relation-truncation metadata through the CLI contract', async () => {
    const config = writeWorkspace();
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
    writeIntentFile('sample-repo', {
      schemaVersion: 2,
      projectId: 'sample-project',
      domains: [{ id: 'ordering', title: 'Ordering' }],
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
    });

    const result = await runIntentContext({
      config,
      projectId: 'sample-project',
      request: { intentIds: ['cap-hub'] },
    });
    expect(result.relations).toHaveLength(50);
    expect(result.relationsTruncated).toBe(true);
    expect(result.omittedRelationCount).toBe(10);
  });

  it('returns accepted items only by default and carries the anchor warning', async () => {
    const config = writeWorkspace();
    writeIntentFile('sample-repo', intentFileJson('sample-project'));
    const result = await runIntentContext({
      config,
      projectId: 'sample-project',
      request: {},
      resolveEvidence: evidenceFor(AnchorStatus.Matched, SnapshotFreshness.Current),
    });
    expect(result.items?.map((entry) => entry.item.id)).toEqual([
      'br-orders-never-exceed-stock',
      'cap-widget-ordering',
    ]);
    expect(result.warning).toBe(INTENT_ANCHOR_WARNING);
    expect(result.warning).toMatch(/not conformance proof/i);
  });

  it('renders anchor status and snapshot freshness independently (matched + stale)', async () => {
    const config = writeWorkspace();
    writeIntentFile('sample-repo', intentFileJson('sample-project'));
    const result = await runIntentContext({
      config,
      projectId: 'sample-project',
      request: { intentIds: ['cap-widget-ordering'] },
      resolveEvidence: evidenceFor(AnchorStatus.Matched, SnapshotFreshness.Stale),
    });
    const anchors = result.items?.[0]?.anchors ?? [];
    expect(anchors[0]?.status).toBe(AnchorStatus.Matched);
    expect(anchors[0]?.snapshotFreshness).toBe(SnapshotFreshness.Stale);
    expect(result.repos?.[0]?.snapshotFreshness).toBe(SnapshotFreshness.Stale);
  });

  it('surfaces a ready-but-no-match result distinctly from not_configured', async () => {
    const config = writeWorkspace();
    writeIntentFile('sample-repo', intentFileJson('sample-project'));
    const result = await runIntentContext({
      config,
      projectId: 'sample-project',
      request: { query: 'nothing matches this phrase' },
      resolveEvidence: evidenceFor(AnchorStatus.Matched, SnapshotFreshness.Current),
    });
    expect(result.status).toBe(IntentOverlayStatus.Ready);
    expect(result.items).toEqual([]);
    expect(result.totalMatched).toBe(0);
  });

  it('returns intent data with evidence unavailable when the graph is missing', async () => {
    const config = writeWorkspace();
    writeIntentFile('sample-repo', intentFileJson('sample-project'));
    const result = await runIntentContext({
      config,
      projectId: 'sample-project',
      request: { intentIds: ['cap-widget-ordering'] },
      resolveEvidence: async () => {
        throw new Error('database unavailable');
      },
    });
    expect(result.items?.[0]?.item.id).toBe('cap-widget-ordering');
    expect(result.items?.[0]?.anchors).toEqual([]);
    expect(result.evidence.available).toBe(false);
    expect(result.evidence.reason).toContain('database unavailable');
    expect(result.repos).toBeUndefined();
  });

  it('reaches candidates only on opt-in and reports truncation metadata', async () => {
    const config = writeWorkspace();
    writeIntentFile('sample-repo', intentFileJson('sample-project'));
    const base = {
      config,
      projectId: 'sample-project',
      resolveEvidence: evidenceFor(AnchorStatus.Matched, SnapshotFreshness.Current),
    };

    const withoutOptIn = await runIntentContext({ ...base, request: {} });
    expect(withoutOptIn.items?.map((entry) => entry.item.id)).not.toContain('dec-refuse-over-stock-orders');

    const withOptIn = await runIntentContext({ ...base, request: { includeCandidates: true, limit: 2 } });
    expect(withOptIn.items?.map((entry) => entry.item.id)).toEqual([
      'br-orders-never-exceed-stock',
      'cap-widget-ordering',
    ]);
    expect(withOptIn.truncated).toBe(true);
    expect(withOptIn.omittedCount).toBe(1);
    expect(withOptIn.items?.[0]?.matchReason).toBe(IntentMatchReason.Default);
  });

  it('reports an invalid overlay without querying the graph', async () => {
    const config = writeWorkspace();
    writeIntentFile('sample-repo', {
      schemaVersion: 2,
      projectId: 'sample-project',
      domains: [],
      items: [],
      relations: 'nope',
    });
    let called = false;
    const result = await runIntentContext({
      config,
      projectId: 'sample-project',
      request: {},
      resolveEvidence: async () => {
        called = true;
        throw new Error('should not be called');
      },
    });
    expect(result.status).toBe(IntentOverlayStatus.Invalid);
    expect(result.items).toBeUndefined();
    expect(called).toBe(false);
  });
});

// AC-16 — the CLI `--domain` filter, and AC-20 — the v1 remediation text
describe('runIntentContext --domain (AC-16)', () => {
  const base = (config: RuntimeConfig) => ({
    config,
    projectId: 'sample-project',
    resolveEvidence: evidenceFor(AnchorStatus.Matched, SnapshotFreshness.Current),
  });

  it('returns only the items of the requested domain', async () => {
    const config = writeWorkspace();
    writeIntentFile('sample-repo', intentFileJson('sample-project'));
    const result = await runIntentContext({ ...base(config), request: { domain: 'stock' } });
    expect(result.items?.map((entry) => entry.item.id)).toEqual(['br-orders-never-exceed-stock']);
    expect(result.items?.[0]?.item.domain).toBe('stock');
  });

  it('composes with a query and leaves exact --id lookups unfiltered (BR-8)', async () => {
    const config = writeWorkspace();
    writeIntentFile('sample-repo', intentFileJson('sample-project'));

    const composed = await runIntentContext({
      ...base(config),
      request: { domain: 'ordering', query: 'widget' },
    });
    expect(composed.items?.map((entry) => entry.item.id)).toEqual(['cap-widget-ordering']);

    const exact = await runIntentContext({
      ...base(config),
      request: { domain: 'stock', intentIds: ['cap-widget-ordering'] },
    });
    expect(exact.items?.map((entry) => entry.item.id)).toEqual(['cap-widget-ordering']);
  });

  it('reports a declared-but-empty domain as no match, and an undeclared one as an error', async () => {
    const config = writeWorkspace();
    writeIntentFile('sample-repo', intentFileJson('sample-project'));

    const empty = await runIntentContext({ ...base(config), request: { domain: 'returns' } });
    expect(empty.status).toBe(IntentOverlayStatus.Ready);
    expect(empty.items).toEqual([]);

    await expect(runIntentContext({ ...base(config), request: { domain: 'payments' } })).rejects.toThrow(
      /not declared by this overlay/,
    );
  });
});

describe('runIntentStatus — per-domain composition (UC-10)', () => {
  it('reports every declared domain in registry order, including an unused one', async () => {
    const config = writeWorkspace();
    writeIntentFile('sample-repo', intentFileJson('sample-project'));
    const result = await runIntentStatus({
      config,
      projectId: 'sample-project',
      resolveEvidence: evidenceFor(AnchorStatus.Matched, SnapshotFreshness.Current),
    });

    expect(result.domains?.map((domain) => domain.id)).toEqual(['ordering', 'stock', 'returns']);
    expect(result.domains?.[0]).toMatchObject({ items: 1, byAuthority: { [IntentAuthority.Accepted]: 1 } });
    expect(result.domains?.[1]).toMatchObject({
      items: 2,
      byAuthority: { [IntentAuthority.Accepted]: 1, [IntentAuthority.Candidate]: 1 },
    });
    expect(result.domains?.[2]).toMatchObject({ items: 0, byAuthority: {} });
  });
});

describe('a pre-migration v1 overlay is refused with its remediation (AC-20)', () => {
  const v1Overlay = {
    schemaVersion: 1,
    projectId: 'sample-project',
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

  it('surfaces the remediation verbatim through validate, status, and context', async () => {
    const config = writeWorkspace();
    writeIntentFile('sample-repo', v1Overlay);

    const validate = runIntentValidate({ config, projectId: 'sample-project' });
    expect(validate.status).toBe(IntentOverlayStatus.Invalid);
    expect(validate.errors).toHaveLength(1);
    expect(validate.errors?.[0]?.code).toBe(IntentValidationCode.LegacySchemaVersion);
    expect(validate.errors?.[0]?.message).toBe(LEGACY_SCHEMA_REMEDIATION);

    const status = await runIntentStatus({ config, projectId: 'sample-project' });
    expect(status.status).toBe(IntentOverlayStatus.Invalid);
    expect(status.message).toContain(LEGACY_SCHEMA_REMEDIATION);

    const context = await runIntentContext({ config, projectId: 'sample-project', request: {} });
    expect(context.status).toBe(IntentOverlayStatus.Invalid);
    expect(context.message).toContain(LEGACY_SCHEMA_REMEDIATION);
    expect(context.items).toBeUndefined();
  });
});

// Real-wiring: `createGraphEvidenceResolver` against an actual sqlite project
// graph, not the injected fakes the rest of this file uses. Proves the real
// factory (repo-hash computation + `resolveIntentEvidence` + `@coredoc/db`
// read path) actually resolves an anchor end to end.
describe('createGraphEvidenceResolver (real sqlite backend)', () => {
  afterEach(async () => {
    await closeProjectDatabases();
  });

  it('resolves a matched anchor against a real pushed graph node', async () => {
    const config = writeWorkspace(['sample-repo'], 'sample-project');
    const repoHash = repoHashesForProject({ repos: [{ name: 'sample-repo' }] })['sample-repo'] as string;
    const nodeId = `${repoHash}:function:src/widgets/order.ts:placeOrder`;
    const versionedId = `${nodeId}@1111`;

    const node: GraphNode = {
      id: nodeId,
      type: NodeType.Function,
      name: 'placeOrder',
      repoId: repoHash,
      filePath: 'src/widgets/order.ts',
      startLine: 1,
      endLine: 5,
      properties: { versionedId },
    } as GraphNode;
    const project = await openProjectDatabase(config.configDir, 'sample-project');
    await project.graph.pushNodes([node]);

    writeIntentFile('sample-repo', {
      schemaVersion: 2,
      projectId: 'sample-project',
      domains: [{ id: 'ordering', title: 'Ordering' }],
      items: [
        {
          id: 'cap-widget-ordering',
          domain: 'ordering',
          kind: 'capability',
          title: 'Widget ordering',
          statement: 'A store operator can order widgets for one warehouse.',
          authority: 'accepted',
          payload: {
            outcome: 'An operator places a widget order',
            beneficiary: 'Store operator',
            boundary: 'Single warehouse',
          },
          sources: [{ kind: 'spec', ref: 'spec/widget-ordering', localId: 'CAP-1' }],
          codeAnchors: [
            {
              repo: 'sample-repo',
              nodeId,
              nodeType: 'function',
              capturedVersionedId: versionedId,
              rationale: 'Entry point that performs the ordering outcome',
            },
          ],
        },
      ],
      relations: [],
    });

    const target = resolveIntentTarget(config, 'sample-project');
    const result = await runIntentStatus({
      config,
      projectId: 'sample-project',
      resolveEvidence: createGraphEvidenceResolver(config, target),
    });

    expect(result.evidence.available).toBe(true);
    expect(result.anchorCounts?.[AnchorStatus.Matched]).toBe(1);
  });
});

// =============================================================================
// `coredoc intent capture` — the ONE sanctioned agent write path (AC-3, AC-4, AC-11)
// =============================================================================

const CAPTURE_PROPOSAL = {
  id: 'cap-widget-returns',
  domain: 'returns',
  kind: 'capability',
  title: 'Widget returns',
  statement: 'A store operator can return a widget within the return window.',
  payload: {
    outcome: 'A returned widget is credited back to the operator',
    beneficiary: 'Store operator',
    boundary: 'Returns inside the return window only',
  },
  sources: [{ kind: 'spec', ref: 'spec/widget-returns', localId: 'CAP-9' }],
};

function proposalsDoc(items: unknown[] = [CAPTURE_PROPOSAL]): string {
  return JSON.stringify({ items });
}

function writeProposalsFile(items: unknown[] = [CAPTURE_PROPOSAL]): string {
  const filePath = path.join(workspace, 'proposals.json');
  fs.writeFileSync(filePath, proposalsDoc(items));
  return filePath;
}

function readOverlay(repoName = 'sample-repo'): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(workspace, repoName, '.coredoc', 'intent.json'), 'utf-8'));
}

describe('runIntentCapture — UC-1 candidate capture', () => {
  it('creates the overlay on a first capture and writes the proposal as a candidate (AC-3)', () => {
    const config = writeWorkspace();
    const result = runIntentCapture({
      config,
      projectId: 'sample-project',
      input: writeProposalsFile(),
    });

    expect(result.createdFile).toBe(true);
    expect(result.createdItemIds).toEqual(['cap-widget-returns']);
    const overlay = readOverlay() as { items: Array<{ authority: string }> };
    expect(overlay.items[0]?.authority).toBe('candidate');
  });

  it('reads the proposals document from stdin when the input is "-"', () => {
    const config = writeWorkspace();
    const result = runIntentCapture({
      config,
      projectId: 'sample-project',
      input: '-',
      readStdin: () => proposalsDoc(),
    });
    expect(result.createdItemIds).toEqual(['cap-widget-returns']);
  });

  it('is an idempotent no-op on re-capture of the same source identity (AC-4)', () => {
    const config = writeWorkspace();
    const input = writeProposalsFile();
    runIntentCapture({ config, projectId: 'sample-project', input });
    const before = fs.readFileSync(path.join(workspace, 'sample-repo', '.coredoc', 'intent.json'), 'utf-8');

    const second = runIntentCapture({ config, projectId: 'sample-project', input });

    expect(second.changed).toBe(false);
    expect(second.unchangedItemIds).toEqual(['cap-widget-returns']);
    expect(fs.readFileSync(path.join(workspace, 'sample-repo', '.coredoc', 'intent.json'), 'utf-8')).toBe(before);
  });

  it('preserves an accepted item sharing the proposal source identity (AC-4, BR-2)', () => {
    const config = writeWorkspace();
    writeIntentFile('sample-repo', intentFileJson('sample-project'));
    const before = readOverlay() as { items: Array<{ id: string }> };

    const result = runIntentCapture({
      config,
      projectId: 'sample-project',
      input: writeProposalsFile([
        { ...CAPTURE_PROPOSAL, sources: [{ kind: 'spec', ref: 'spec/widget-ordering', localId: 'CAP-1' }] },
      ]),
    });

    expect(result.preservedAcceptedItemIds).toEqual(['cap-widget-ordering']);
    const after = readOverlay() as { items: Array<{ id: string }> };
    expect(after.items.find((item) => item.id === 'cap-widget-ordering')).toEqual(
      before.items.find((item) => item.id === 'cap-widget-ordering'),
    );
  });
});

describe('runIntentCapture — slug ids (AC-15)', () => {
  it('derives the id of a proposal that omits one, and declares its domain on the created overlay', () => {
    const config = writeWorkspace();
    const { id: _id, ...withoutId } = CAPTURE_PROPOSAL;
    const result = runIntentCapture({
      config,
      projectId: 'sample-project',
      input: writeProposalsFile([withoutId]),
    });

    expect(result.createdItemIds).toEqual(['cap-widget-returns']);
    expect(result.seededDomainIds).toEqual(['returns']);
    const overlay = readOverlay() as { domains: Array<{ id: string }> };
    expect(overlay.domains.map((domain) => domain.id)).toEqual(['returns']);
  });

  it('reports a supplied id the existing item did not adopt (BR-17)', () => {
    const config = writeWorkspace();
    runIntentCapture({ config, projectId: 'sample-project', input: writeProposalsFile() });

    const result = runIntentCapture({
      config,
      projectId: 'sample-project',
      input: writeProposalsFile([
        { ...CAPTURE_PROPOSAL, id: 'cap-widget-returns-renamed', statement: 'An operator returns a widget.' },
      ]),
    });

    expect(result.updatedItemIds).toEqual(['cap-widget-returns']);
    expect(result.ignoredProposalIds).toEqual(['cap-widget-returns-renamed']);
  });

  it('rejects a legacy-style proposal id before anything is written (BR-16)', () => {
    const config = writeWorkspace();
    expect(() =>
      runIntentCapture({
        config,
        projectId: 'sample-project',
        input: writeProposalsFile([{ ...CAPTURE_PROPOSAL, id: 'CAP-9' }]),
      }),
    ).toThrow(IntentProposalsInvalidError);
    expect(fs.existsSync(path.join(workspace, 'sample-repo', '.coredoc', 'intent.json'))).toBe(false);
  });
});

describe('runIntentCapture — refusals (AC-11, BR-2)', () => {
  it('rejects a proposals document that is not parseable JSON', () => {
    const config = writeWorkspace();
    const filePath = path.join(workspace, 'proposals.json');
    fs.writeFileSync(filePath, '{ not json');
    expect(() => runIntentCapture({ config, projectId: 'sample-project', input: filePath })).toThrow(/JSON/i);
  });

  it('rejects a proposal carrying an unknown key and never writes the marker (AC-11)', () => {
    const config = writeWorkspace();
    const input = writeProposalsFile([
      { ...CAPTURE_PROPOSAL, sourceBody: 'LEAKED-MARKER-abcdef', transcript: 'LEAKED-MARKER-abcdef' },
    ]);

    expect(() => runIntentCapture({ config, projectId: 'sample-project', input })).toThrow(IntentProposalsInvalidError);
    expect(fs.existsSync(path.join(workspace, 'sample-repo', '.coredoc', 'intent.json'))).toBe(false);
  });

  it('rejects an oversized payload field without writing (AC-11)', () => {
    const config = writeWorkspace();
    const input = writeProposalsFile([
      { ...CAPTURE_PROPOSAL, payload: { ...CAPTURE_PROPOSAL.payload, outcome: 'LEAKED-MARKER-'.repeat(500) } },
    ]);
    expect(() => runIntentCapture({ config, projectId: 'sample-project', input })).toThrow(IntentProposalsInvalidError);
    expect(fs.existsSync(path.join(workspace, 'sample-repo', '.coredoc', 'intent.json'))).toBe(false);
  });

  it('rejects a proposal that sets authority itself (BR-1)', () => {
    const config = writeWorkspace();
    const input = writeProposalsFile([{ ...CAPTURE_PROPOSAL, authority: 'accepted' }]);
    expect(() => runIntentCapture({ config, projectId: 'sample-project', input })).toThrow(/authority/i);
  });

  it('refuses to write over an invalid overlay', () => {
    const config = writeWorkspace();
    writeIntentFile('sample-repo', {
      schemaVersion: 2,
      projectId: 'sample-project',
      domains: [],
      items: [{ id: 'broken' }],
    });
    const before = fs.readFileSync(path.join(workspace, 'sample-repo', '.coredoc', 'intent.json'), 'utf-8');

    expect(() => runIntentCapture({ config, projectId: 'sample-project', input: writeProposalsFile() })).toThrow(
      IntentOverlayInvalidError,
    );
    expect(fs.readFileSync(path.join(workspace, 'sample-repo', '.coredoc', 'intent.json'), 'utf-8')).toBe(before);
  });

  it('refuses an overlay belonging to another project', () => {
    const config = writeWorkspace(['sample-repo'], 'sample-project');
    writeIntentFile('sample-repo', intentFileJson('other-project'));
    expect(() => runIntentCapture({ config, projectId: 'sample-project', input: writeProposalsFile() })).toThrow(
      /other-project/,
    );
  });

  it('refuses a proposal id that already belongs to an accepted item (IntentCaptureError)', () => {
    const config = writeWorkspace();
    writeIntentFile('sample-repo', intentFileJson('sample-project'));
    const before = fs.readFileSync(path.join(workspace, 'sample-repo', '.coredoc', 'intent.json'), 'utf-8');

    expect(() =>
      runIntentCapture({
        config,
        projectId: 'sample-project',
        input: writeProposalsFile([{ ...CAPTURE_PROPOSAL, id: 'cap-widget-ordering' }]),
      }),
    ).toThrow(IntentCaptureError);
    expect(fs.readFileSync(path.join(workspace, 'sample-repo', '.coredoc', 'intent.json'), 'utf-8')).toBe(before);
  });
});

describe('runIntentCapture — bounded, non-echoing input handling (AC-11)', () => {
  it('refuses a proposals file above the intent file size cap before parsing it', () => {
    const config = writeWorkspace();
    const filePath = path.join(workspace, 'huge-proposals.json');
    fs.writeFileSync(filePath, `{"items":[${'A'.repeat(MAX_INTENT_FILE_BYTES)}`);

    expect(() => runIntentCapture({ config, projectId: 'sample-project', input: filePath })).toThrow(
      new RegExp(`${MAX_INTENT_FILE_BYTES}`),
    );
  });

  it('refuses a proposals input that is not a regular file', () => {
    const config = writeWorkspace();
    expect(() => runIntentCapture({ config, projectId: 'sample-project', input: workspace })).toThrow(
      /not a regular file/,
    );
  });

  it('refuses stdin above the intent file size cap', () => {
    const config = writeWorkspace();
    expect(() =>
      runIntentCapture({
        config,
        projectId: 'sample-project',
        input: '-',
        readStdin: () => 'A'.repeat(MAX_INTENT_FILE_BYTES + 1),
      }),
    ).toThrow(new RegExp(`${MAX_INTENT_FILE_BYTES}`));
  });

  it('never echoes the offending bytes of an unparseable proposals document', () => {
    const config = writeWorkspace();
    const filePath = path.join(workspace, 'proposals.json');
    fs.writeFileSync(filePath, 'LEAKME not json at all');

    expect(() => runIntentCapture({ config, projectId: 'sample-project', input: filePath })).toThrow(
      /not parseable JSON/,
    );
    try {
      runIntentCapture({ config, projectId: 'sample-project', input: filePath });
    } catch (error) {
      expect((error as Error).message).not.toContain('LEAKME');
    }
  });
});

// AC-21/AC-22 at the CLI surface — `coredoc intent list`.
describe('runIntentList / printListResult (AC-21, AC-22)', () => {
  /** Captures the two streams separately: `--ids` stdout must stay a clean id list. */
  function capture(run: () => void): { out: string[]; err: string[] } {
    const out: string[] = [];
    const err: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((line?: unknown) => void out.push(String(line ?? '')));
    const errorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation((line?: unknown) => void err.push(String(line ?? '')));
    try {
      run();
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
    return { out, err };
  }

  it('returns the full registry and payload-free entries, in deterministic order', () => {
    const config = writeWorkspace();
    writeIntentFile('sample-repo', intentFileJson('sample-project'));
    const result = runIntentList({ config, projectId: 'sample-project', request: {} });

    expect(result.status).toBe(IntentOverlayStatus.Ready);
    expect(result.domains).toEqual([
      { id: 'ordering', title: 'Ordering' },
      { id: 'stock', title: 'Stock and warehouses' },
      { id: 'returns', title: 'Returns' },
    ]);
    expect(result.entries).toEqual([
      {
        id: 'cap-widget-ordering',
        title: 'Widget ordering',
        kind: 'capability',
        domain: 'ordering',
        authority: IntentAuthority.Accepted,
      },
      {
        id: 'br-orders-never-exceed-stock',
        title: 'Orders never exceed stock',
        kind: 'business_rule',
        domain: 'stock',
        authority: IntentAuthority.Accepted,
      },
    ]);
    expect(result.truncated).toBe(false);
  });

  it('composes --domain and --kind and adds candidates only on opt-in', () => {
    const config = writeWorkspace();
    writeIntentFile('sample-repo', intentFileJson('sample-project'));
    const base = { config, projectId: 'sample-project' };

    expect(
      runIntentList({ ...base, request: { domain: 'stock', includeCandidates: true } }).entries?.map((e) => e.id),
    ).toEqual(['br-orders-never-exceed-stock', 'dec-refuse-over-stock-orders']);
    expect(
      runIntentList({ ...base, request: { kind: 'decision' as IntentKind, includeCandidates: true } }).entries?.map(
        (e) => e.id,
      ),
    ).toEqual(['dec-refuse-over-stock-orders']);
    expect(runIntentList({ ...base, request: { kind: 'decision' as IntentKind } }).entries).toEqual([]);
  });

  it('prints the domains block then one line per entry', () => {
    const config = writeWorkspace();
    writeIntentFile('sample-repo', intentFileJson('sample-project'));
    const result = runIntentList({ config, projectId: 'sample-project', request: {} });
    const { out, err } = capture(() => printListResult(result));

    expect(err).toEqual([]);
    expect(out).toContain('  Domains:  3');
    expect(out).toContain('    ordering  Ordering');
    expect(out).toContain('  Items:    2');
    expect(
      out.some((line) => line.includes('cap-widget-ordering') && line.includes('[capability/ordering/accepted]')),
    ).toBe(true);
    expect(out.join('\n')).not.toContain('payload');
  });

  it('prints slug ids only under --ids', () => {
    const config = writeWorkspace();
    writeIntentFile('sample-repo', intentFileJson('sample-project'));
    const result = runIntentList({ config, projectId: 'sample-project', request: { includeCandidates: true } });
    const { out, err } = capture(() => printListResult(result, { idsOnly: true }));

    expect(out).toEqual(['cap-widget-ordering', 'br-orders-never-exceed-stock', 'dec-refuse-over-stock-orders']);
    expect(err).toEqual([]);
  });

  it('reports a declared-but-empty domain as an empty index, and an undeclared one as an error', () => {
    const config = writeWorkspace();
    writeIntentFile('sample-repo', intentFileJson('sample-project'));

    const empty = runIntentList({ config, projectId: 'sample-project', request: { domain: 'returns' } });
    expect(empty.status).toBe(IntentOverlayStatus.Ready);
    expect(empty.entries).toEqual([]);
    expect(empty.domains).toHaveLength(3);

    expect(() => runIntentList({ config, projectId: 'sample-project', request: { domain: 'payments' } })).toThrow(
      /not declared by this overlay/,
    );
  });

  it('errors on an unknown kind, naming the valid kinds', () => {
    const config = writeWorkspace();
    writeIntentFile('sample-repo', intentFileJson('sample-project'));
    expect(() =>
      runIntentList({ config, projectId: 'sample-project', request: { kind: 'note' as IntentKind } }),
    ).toThrow(/valid kinds: capability, use_case, flow, business_rule, limitation, decision/);
  });

  it('keeps an absent overlay a non-error state and writes nothing to stdout', () => {
    const config = writeWorkspace();
    const result = runIntentList({ config, projectId: 'sample-project', request: {} });
    expect(result.status).toBe(IntentOverlayStatus.NotConfigured);
    expect(fs.existsSync(result.intentPath)).toBe(false);

    const { out, err } = capture(() => printListResult(result, { idsOnly: true }));
    expect(out).toEqual([]);
    expect(err[0]).toContain('No intent overlay for project "sample-project"');
  });

  it('refuses an invalid overlay and a v1 legacy overlay with their remediation (AC-20)', () => {
    const config = writeWorkspace();
    const broken = intentFileJson('sample-project') as { items: Array<Record<string, unknown>> };
    broken.items[0]!.kind = 'note';
    writeIntentFile('sample-repo', broken);
    const invalid = runIntentList({ config, projectId: 'sample-project', request: {} });
    expect(invalid.status).toBe(IntentOverlayStatus.Invalid);
    expect(invalid.entries).toBeUndefined();

    writeIntentFile('sample-repo', { schemaVersion: 1, projectId: 'sample-project', items: [], relations: [] });
    const legacy = runIntentList({ config, projectId: 'sample-project', request: {} });
    expect(legacy.status).toBe(IntentOverlayStatus.Invalid);
    expect(legacy.message).toContain(LEGACY_SCHEMA_REMEDIATION);

    const { out, err } = capture(() => printListResult(legacy));
    expect(out).toEqual([]);
    expect(err.join('\n')).toContain(LEGACY_SCHEMA_REMEDIATION);
  });
});

// `intent context` renders agent-authored title/statement text to the very
// terminal a maintainer uses to review a candidate — an embedded ANSI/OSC
// escape there could rewrite that review surface. The human output path must
// strip control bytes at render time (the JSON path already escapes them).
describe('printContextResult — control-character sanitization of untrusted text', () => {
  function captureLog(run: () => void): string[] {
    const out: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((line?: unknown) => void out.push(String(line ?? '')));
    try {
      run();
    } finally {
      logSpy.mockRestore();
    }
    return out;
  }

  it('drops ESC/CSI/OSC and other control bytes from the rendered title and statement', () => {
    const item = {
      id: 'cap-widget-ordering',
      domain: 'ordering',
      kind: 'capability',
      // A clear-screen CSI in the title and an OSC window-title hijack (with its
      // BEL terminator) in the statement — both agent-authored, both untrusted.
      title: 'Widget[2J ordering',
      statement: 'An operator]0;pwned can order widgets.',
      authority: IntentAuthority.Accepted,
      payload: {},
      sources: [{ kind: 'spec', ref: 'spec/widget-ordering', localId: 'CAP-1' }],
    };
    const result = {
      projectId: 'sample-project',
      repo: 'sample-repo',
      intentPath: '/tmp/.coredoc/intent.json',
      status: IntentOverlayStatus.Ready,
      items: [{ item, matchReason: IntentMatchReason.Default, anchors: [] }],
      relations: [],
      evidence: { available: false, reason: 'no graph' },
      warning: INTENT_ANCHOR_WARNING,
    } as unknown as Parameters<typeof printContextResult>[0];

    const joined = captureLog(() => printContextResult(result)).join('\n');
    expect(joined).not.toContain('');
    expect(joined).not.toContain('');
    // The rendering still happened and the printable text survives.
    expect(joined).toContain('cap-widget-ordering');
    expect(joined).toContain('can order widgets.');
  });

  it('strips control bytes from the source ref in the context render', () => {
    const item = {
      id: 'cap-widget-ordering',
      domain: 'ordering',
      kind: 'capability',
      title: 'Widget ordering',
      statement: 'An operator can order widgets.',
      authority: IntentAuthority.Accepted,
      payload: {},
      // ref is agent-authored free text — a CSI hidden in it must not reach the terminal.
      sources: [{ kind: 'spec', ref: `spec/widget${String.fromCharCode(27)}[2J`, localId: 'CAP-1' }],
    };
    const result = {
      projectId: 'sample-project',
      repo: 'sample-repo',
      intentPath: '/tmp/.coredoc/intent.json',
      status: IntentOverlayStatus.Ready,
      items: [{ item, matchReason: IntentMatchReason.Default, anchors: [] }],
      relations: [],
      evidence: { available: false, reason: 'no graph' },
      warning: INTENT_ANCHOR_WARNING,
    } as unknown as Parameters<typeof printContextResult>[0];

    const joined = captureLog(() => printContextResult(result)).join('\n');
    expect(joined).not.toContain(String.fromCharCode(27));
    expect(joined).toContain('spec/widget'); // printable text survives, minus the CSI
  });

  it('strips control bytes from entry and domain titles in the list render', () => {
    const esc = String.fromCharCode(27);
    const result = {
      projectId: 'sample-project',
      repo: 'sample-repo',
      intentPath: '/tmp/.coredoc/intent.json',
      status: IntentOverlayStatus.Ready,
      domains: [{ id: 'ordering', title: `Order${esc}[2Jing` }],
      entries: [
        {
          id: 'cap-widget-ordering',
          title: `Widget${esc}]0;pwned ordering`,
          kind: 'capability',
          domain: 'ordering',
          authority: IntentAuthority.Accepted,
        },
      ],
      truncated: false,
      totalMatched: 1,
    } as unknown as Parameters<typeof printListResult>[0];

    const joined = captureLog(() => printListResult(result)).join('\n');
    expect(joined).not.toContain(esc);
    // Printable text and the machine-readable id survive.
    expect(joined).toContain('cap-widget-ordering');
    expect(joined).toContain('Widget');
    expect(joined).toContain('ing'); // from the sanitized domain title
  });
});

// The renderers are the only thing a maintainer actually sees: a result object
// can carry the right field while the print layer drops it. Each case below
// pins ONE load-bearing line — the ones a silent regression would make a
// maintainer act on a wrong picture of the overlay.
describe('intent renderers — the load-bearing lines', () => {
  function capture(run: () => void): { out: string[]; err: string[] } {
    const out: string[] = [];
    const err: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((line?: unknown) => void out.push(String(line ?? '')));
    const errorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation((line?: unknown) => void err.push(String(line ?? '')));
    try {
      run();
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
    return { out, err };
  }

  describe('printValidateResult', () => {
    it('renders a valid overlay with its counts', () => {
      const config = writeWorkspace();
      writeIntentFile('sample-repo', intentFileJson('sample-project'));
      const { out, err } = capture(() =>
        printValidateResult(runIntentValidate({ config, projectId: 'sample-project' })),
      );

      expect(err).toEqual([]);
      expect(out[0]).toContain('is valid');
      expect(out).toContain('  Items:        3');
      expect(out).toContain('  Relations:    2');
      expect(out).toContain('  Code anchors: 1');
    });

    it('renders an absent overlay as an opt-in state, not a failure', () => {
      const config = writeWorkspace();
      const { out, err } = capture(() =>
        printValidateResult(runIntentValidate({ config, projectId: 'sample-project' })),
      );

      expect(err).toEqual([]);
      expect(out.join('\n')).toContain('No intent overlay for project "sample-project"');
      expect(out.join('\n')).toContain('not an error');
    });

    it('renders every validation error path on stderr and says nothing was written', () => {
      const config = writeWorkspace();
      const broken = intentFileJson('sample-project');
      (broken.relations as Record<string, unknown>[])[0] = {
        from: 'GHOST',
        type: 'governs',
        to: 'cap-widget-ordering',
      };
      writeIntentFile('sample-repo', broken);
      const { out, err } = capture(() =>
        printValidateResult(runIntentValidate({ config, projectId: 'sample-project' })),
      );

      expect(out).toEqual([]);
      expect(err.join('\n')).toContain('is invalid');
      expect(err.some((line) => line.includes('relations'))).toBe(true);
      expect(err.join('\n')).toContain('Nothing was written.');
    });
  });

  describe('printStatusResult', () => {
    it('renders the anchor histogram, the unanchored item count, and the fixed anchor caveat', async () => {
      const config = writeWorkspace();
      writeIntentFile('sample-repo', intentFileJson('sample-project'));
      const result = await runIntentStatus({
        config,
        projectId: 'sample-project',
        resolveEvidence: evidenceFor(AnchorStatus.Changed, SnapshotFreshness.Stale),
      });
      const { out, err } = capture(() => printStatusResult(result));

      expect(err).toEqual([]);
      expect(out.join('\n')).toContain('  Anchor status:');
      expect(out.some((line) => line.trim() === `${AnchorStatus.Changed}: 1`)).toBe(true);
      expect(out).toContain('  Unanchored items: 2');
      expect(out.join('\n')).toContain(`Graph snapshot (sample-repo): ${SnapshotFreshness.Stale}`);
      // Every rendered status carries LIM-2 — an unchanged anchor is not proof.
      expect(out.join('\n')).toContain(INTENT_ANCHOR_WARNING);
      // The domain registry doubles as the discovery path for `--domain`.
      expect(out).toContain('  Domains:      3');
      expect(out.some((line) => line.includes('returns (Returns): 0 item(s)'))).toBe(true);
    });

    it('renders UNAVAILABLE with its reason when the graph could not be queried (BR-9)', async () => {
      const config = writeWorkspace();
      writeIntentFile('sample-repo', intentFileJson('sample-project'));
      const result = await runIntentStatus({
        config,
        projectId: 'sample-project',
        resolveEvidence: async () => {
          throw new Error('no graph data for project "sample-project"');
        },
      });
      const { out } = capture(() => printStatusResult(result));

      // The intent is still reported; only its code dimension is unknown.
      expect(out).toContain('  Items:        3');
      expect(out.join('\n')).toContain('Code evidence: UNAVAILABLE');
      expect(out.join('\n')).toContain('no graph data');
      expect(out.join('\n')).not.toContain('Anchor status:');
    });

    it('renders not_configured without counts and invalid on stderr', async () => {
      const config = writeWorkspace();
      const absent = await runIntentStatus({ config, projectId: 'sample-project' });
      const missing = capture(() => printStatusResult(absent));
      expect(missing.out.join('\n')).toContain(`Overlay:  ${IntentOverlayStatus.NotConfigured}`);
      expect(missing.out.join('\n')).not.toContain('Items:');

      const broken = intentFileJson('sample-project') as { items: Array<Record<string, unknown>> };
      broken.items[0]!.kind = 'note';
      writeIntentFile('sample-repo', broken);
      const invalid = await runIntentStatus({ config, projectId: 'sample-project' });
      const rendered = capture(() => printStatusResult(invalid));
      expect(rendered.out.join('\n')).toContain(`Overlay:  ${IntentOverlayStatus.Invalid}`);
      expect(rendered.err.join('\n')).toContain('is invalid');
    });
  });

  describe('printCaptureResult', () => {
    it('renders the seeded placeholder domains of a first capture', () => {
      const config = writeWorkspace();
      const result = runIntentCapture({ config, projectId: 'sample-project', input: writeProposalsFile() });
      const { out } = capture(() => printCaptureResult(result));

      expect(out[0]).toContain('Captured into');
      expect(out.join('\n')).toContain('Created a new overlay for this project.');
      expect(out.join('\n')).toContain('declared domains (placeholder titles — rename in review): 1 (returns)');
      expect(out.join('\n')).toContain('created candidates: 1 (cap-widget-returns)');
      expect(out.join('\n')).toContain('acceptance is a reviewed maintainer edit');
    });

    it('renders an ignored proposal id — an agent must not keep citing an id the overlay lacks (BR-17)', () => {
      const config = writeWorkspace();
      runIntentCapture({ config, projectId: 'sample-project', input: writeProposalsFile() });
      const result = runIntentCapture({
        config,
        projectId: 'sample-project',
        input: writeProposalsFile([
          { ...CAPTURE_PROPOSAL, id: 'cap-widget-returns-renamed', statement: 'An operator returns a widget.' },
        ]),
      });
      const { out } = capture(() => printCaptureResult(result));

      expect(result.ignoredProposalIds).toEqual(['cap-widget-returns-renamed']);
      expect(out.join('\n')).toContain('ignored proposal ids (an existing item keeps its id): 1');
      expect(out.join('\n')).toContain('cap-widget-returns-renamed');
    });

    it('renders the stored code anchors a proposal with its own anchor set displaced', () => {
      const config = writeWorkspace();
      runIntentCapture({ config, projectId: 'sample-project', input: writeProposalsFile() });
      // A maintainer anchors the captured candidate by hand, then the same
      // source is re-captured by an agent that names one anchor of its own.
      const overlay = readOverlay() as { items: Array<Record<string, unknown>> };
      const anchorOn = (nodeId: string) => ({
        repo: 'sample-repo',
        nodeId,
        nodeType: 'function',
        capturedVersionedId: `${nodeId}@1111`,
        rationale: 'Performs the returns outcome',
      });
      overlay.items[0]!.codeAnchors = [
        anchorOn('aaaa:function:src/returns.ts:refund'),
        anchorOn('aaaa:function:src/returns.ts:credit'),
      ];
      writeIntentFile('sample-repo', overlay);

      const result = runIntentCapture({
        config,
        projectId: 'sample-project',
        input: writeProposalsFile([
          { ...CAPTURE_PROPOSAL, codeAnchors: [anchorOn('aaaa:function:src/returns.ts:refund')] },
        ]),
      });
      const { out } = capture(() => printCaptureResult(result));

      expect(result.droppedAnchors).toEqual([{ itemId: 'cap-widget-returns', count: 1 }]);
      expect(out.join('\n')).toContain('replaced code anchors on cap-widget-returns: 1 stored anchor(s)');
    });

    it('renders an idempotent re-capture as no change', () => {
      const config = writeWorkspace();
      runIntentCapture({ config, projectId: 'sample-project', input: writeProposalsFile() });
      const result = runIntentCapture({ config, projectId: 'sample-project', input: writeProposalsFile() });
      const { out } = capture(() => printCaptureResult(result));

      expect(out[0]).toContain('No change to');
      expect(out.join('\n')).toContain('unchanged candidates: 1 (cap-widget-returns)');
    });
  });
});

// BR-9's promise is that an absent graph makes the CODE dimension unknown, not
// the intent. Every other context test injects a fake resolver, so the shipped
// no-resolver path — the one an embedding caller hits — is only covered here.
describe('runIntentContext without a resolver (BR-9)', () => {
  it('returns the matched intent and reports the code dimension as never queried', async () => {
    const config = writeWorkspace();
    writeIntentFile('sample-repo', intentFileJson('sample-project'));

    const result = await runIntentContext({
      config,
      projectId: 'sample-project',
      request: { intentIds: ['cap-widget-ordering'] },
    });

    expect(result.status).toBe(IntentOverlayStatus.Ready);
    expect(result.items?.map((entry) => entry.item.id)).toEqual(['cap-widget-ordering']);
    expect(result.evidence.available).toBe(false);
    expect(result.evidence.reason).toBe('No local graph was queried for this run.');
    // The stored anchors are still rendered, with their status called unknown
    // rather than silently absent.
    expect(result.items?.[0]?.anchors).toEqual([]);
    expect(result.items?.[0]?.itemStatus).toBeUndefined();
  });
});

// Pins the render-time sanitization: every untrusted overlay field the human
// surfaces print must lose its C0/C1 bytes. `JSON.stringify` alone is not
// enough — it escapes C0 and passes C1 (8-bit CSI/OSC) through verbatim.
describe('printContextResult — C0/C1 bytes anywhere in the overlay never reach the terminal', () => {
  const ESC = '\x1b';
  const CSI8 = '\x9b';
  const DEL = '\x7f';

  it('strips them from anchor node ids, source local ids, and the payload', () => {
    const item = {
      id: 'cap-widget-ordering',
      domain: 'ordering',
      kind: 'capability',
      title: `Widget${CSI8}[2J ordering`,
      statement: `An operator${DEL} can order widgets.`,
      authority: IntentAuthority.Accepted,
      // The payload travels through `safeJson`, which is the only path where a
      // C1 byte would otherwise survive serialization.
      payload: {
        outcome: `Credited${CSI8}[2J back`,
        beneficiary: `Store${ESC}]0;pwned operator`,
        boundary: `Single${DEL} warehouse`,
      },
      sources: [{ kind: 'spec', ref: `spec/widget${ESC}[2J`, localId: `CAP-1${CSI8}[2J` }],
      codeAnchors: [
        {
          repo: `sample${DEL}-repo`,
          nodeId: `aaaa:function:src/order.ts:place${ESC}[2J`,
          nodeType: 'function',
          capturedVersionedId: 'aaaa:function:src/order.ts:place@1111',
          rationale: `Entry${CSI8} point`,
        },
      ],
    };
    const result = {
      projectId: 'sample-project',
      repo: 'sample-repo',
      intentPath: '/tmp/.coredoc/intent.json',
      status: IntentOverlayStatus.Ready,
      items: [{ item, matchReason: IntentMatchReason.ExactId, anchors: [] }],
      relations: [{ from: `cap-widget-ordering${ESC}[2J`, type: 'governs', to: 'br-orders-never-exceed-stock' }],
      // Evidence unavailable is the branch that renders the STORED anchors.
      evidence: { available: false, reason: 'no graph' },
      warning: INTENT_ANCHOR_WARNING,
    } as unknown as Parameters<typeof printContextResult>[0];

    const out: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((line?: unknown) => void out.push(String(line ?? '')));
    try {
      printContextResult(result);
    } finally {
      logSpy.mockRestore();
    }
    const joined = out.join('\n');

    for (const control of [ESC, CSI8, DEL]) expect(joined).not.toContain(control);
    // The rendering still happened: printable text and the constrained ids survive.
    expect(joined).toContain('cap-widget-ordering');
    expect(joined).toContain('aaaa:function:src/order.ts:place');
    expect(joined).toContain('CAP-1');
    expect(joined).toContain('Credited');
  });
});

// =============================================================================
// Post-cutover reads: frozen, and SAID to be frozen
// =============================================================================
//
// After `coredoc intent import` the overlay on disk stops being authoritative:
// `intent capture` fails fast, but status/context/list/validate keep answering
// from it. That is deliberate (a cut-over repo stays readable offline) and it
// is exactly why the answer has to be LABELLED — an unmarked "Overlay: ready"
// presents stale content as the truth, which is the silent authority split the
// cutover exists to prevent.

describe('post-cutover local reads', () => {
  const CLOUD_WORKSPACE = 'ws_cutover_1';

  /** `writeWorkspace`, plus the cutover marker on the one project. */
  function cutOverConfig(): RuntimeConfig {
    const config = writeWorkspace();
    return {
      ...config,
      projects: config.projects.map((project) => ({
        ...project,
        intent: { mode: 'cloud' as never, workspaceId: CLOUD_WORKSPACE },
      })),
    } as RuntimeConfig;
  }

  function capturedWarnings(run: () => void): string {
    const lines: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation((line?: unknown) => {
      lines.push(String(line));
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      run();
    } finally {
      warn.mockRestore();
      log.mockRestore();
      error.mockRestore();
    }
    return lines.join('\n');
  }

  it('marks validate, list, status and context as non-authoritative', async () => {
    const config = cutOverConfig();
    writeIntentFile('sample-repo', intentFileJson('sample-project'));

    expect(runIntentValidate({ config, projectId: 'sample-project' }).cloudAuthority).toEqual({
      workspaceId: CLOUD_WORKSPACE,
    });
    expect(runIntentList({ config, projectId: 'sample-project', request: {} }).cloudAuthority).toEqual({
      workspaceId: CLOUD_WORKSPACE,
    });
    expect((await runIntentStatus({ config, projectId: 'sample-project' })).cloudAuthority).toEqual({
      workspaceId: CLOUD_WORKSPACE,
    });
    expect((await runIntentContext({ config, projectId: 'sample-project', request: {} })).cloudAuthority).toEqual({
      workspaceId: CLOUD_WORKSPACE,
    });
  });

  it('still ANSWERS the read — a frozen overlay is labelled, never blocked', () => {
    const config = cutOverConfig();
    writeIntentFile('sample-repo', intentFileJson('sample-project'));
    const result = runIntentValidate({ config, projectId: 'sample-project' });
    expect(result.status).toBe(IntentOverlayStatus.Ready);
    expect(result.counts?.items).toBeGreaterThan(0);
  });

  it('prints the warning, naming the owning workspace and how to read the live intent', () => {
    const config = cutOverConfig();
    writeIntentFile('sample-repo', intentFileJson('sample-project'));
    const warnings = capturedWarnings(() =>
      printValidateResult(runIntentValidate({ config, projectId: 'sample-project' })),
    );
    expect(warnings).toContain('NON-AUTHORITATIVE');
    expect(warnings).toContain(CLOUD_WORKSPACE);
    expect(warnings).toContain('coredoc intent export');
  });

  it('keeps the warning off the machine-readable stdout of `list --ids`', () => {
    const config = cutOverConfig();
    writeIntentFile('sample-repo', intentFileJson('sample-project'));
    const stdout: string[] = [];
    const warnings: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((line?: unknown) => {
      stdout.push(String(line));
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation((line?: unknown) => {
      warnings.push(String(line));
    });
    try {
      printListResult(runIntentList({ config, projectId: 'sample-project', request: {} }), { idsOnly: true });
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
    // Every stdout line is an intent id and nothing else.
    expect(stdout.every((line) => /^[a-z0-9-]+$/.test(line))).toBe(true);
    expect(warnings.join('\n')).toContain('NON-AUTHORITATIVE');
  });

  it('says nothing when the project has not cut over', () => {
    const config = writeWorkspace();
    writeIntentFile('sample-repo', intentFileJson('sample-project'));
    const result = runIntentValidate({ config, projectId: 'sample-project' });
    expect(result.cloudAuthority).toBeUndefined();
    expect(capturedWarnings(() => printValidateResult(result))).toBe('');
  });
});
