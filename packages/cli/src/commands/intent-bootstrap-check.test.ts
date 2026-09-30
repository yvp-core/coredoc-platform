/**
 * `coredoc intent bootstrap-check` and the import body ceiling (v1.1-03).
 *
 * Both are refusals that must happen BEFORE the one-way cutover: the ceiling
 * because a 413 from `Content-Length` carries no intent error shape to render,
 * and the readiness verb because the alternative diagnostic is performing the
 * import. The server read is injected, so these prove the composition without a
 * server; what the server answers is proven by the intent Postgres suites.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RuntimeConfig } from '@coredoc/core';
import { MAX_INTENT_IMPORT_BODY_BYTES } from '@coredoc/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IntentApiError, type IntentImportPreflight } from '../sync/workspace-api.js';
import {
  BootstrapCheckId,
  BootstrapCheckStatus,
  assertIntentImportBodyWithinCeiling,
  intentImportBodyBytes,
  runIntentBootstrapCheck,
  type BootstrapCheck,
  type IntentBootstrapTransport,
} from './intent-cloud.js';

const PROJECT = 'sample-project';
const WORKSPACE = 'ws_bootstrap_1';
const REPO = 'sample-repo';

const OVERLAY = {
  schemaVersion: 2,
  projectId: PROJECT,
  domains: [{ id: 'ordering', title: 'Ordering', statement: 'Placing and refusing widget orders.' }],
  items: [
    {
      id: 'cap-widget-ordering',
      kind: 'capability',
      domain: 'ordering',
      title: 'Widget ordering',
      statement: 'The product lets a store operator order widgets for one warehouse.',
      authority: 'accepted',
      sources: [{ kind: 'spec', ref: 'spec/widget-ordering', localId: 'CAP-1' }],
      payload: {
        outcome: 'A store operator can place a widget order and see its state',
        beneficiary: 'Store operator',
        boundary: 'Single warehouse',
      },
      codeAnchors: [
        {
          repo: REPO,
          nodeId: 'aaaa:function:src/widgets/order.ts:placeOrder',
          nodeType: 'function',
          capturedVersionedId: 'aaaa:function:src/widgets/order.ts:placeOrder@1111',
          rationale: 'Entry point that performs the ordering outcome',
        },
      ],
    },
  ],
  relations: [],
};

const PACKET = {
  domain: 'ordering',
  riskTheme: 'money and refund eligibility',
  sources: [
    {
      id: 'approved-returns-spec',
      class: 'A',
      owner: 'Returns owner',
      source: { kind: 'spec', ref: 'spec/returns', localId: 'BR-1', revision: 'abc123' },
    },
  ],
  conflicts: [],
  candidates: [
    {
      framing: 'product_candidate',
      sourceIds: ['approved-returns-spec'],
      proposal: {
        kind: 'business_rule',
        domainId: 'ordering',
        title: 'Refund window',
        statement: 'A refund is available for thirty days after delivery.',
        sources: [{ kind: 'spec', ref: 'spec/returns', localId: 'BR-1', revision: 'abc123' }],
        payload: {
          condition: 'A customer asks for a refund',
          requiredOutcome: 'The refund is granted within thirty days of delivery',
          observer: 'Customer',
        },
      },
    },
  ],
};

function preflight(overrides: Partial<IntentImportPreflight> = {}): IntentImportPreflight {
  return {
    workspaceId: WORKSPACE,
    empty: true,
    content: { domains: 0, features: 0, items: 0 },
    registeredRepoIdentities: [`${REPO} (${REPO})`],
    intentRepoKeys: [REPO],
    ...overrides,
  };
}

function checkFor(checks: readonly BootstrapCheck[], id: BootstrapCheckId): BootstrapCheck {
  const found = checks.find((check) => check.id === id);
  if (!found) throw new Error(`no check reported for ${id}`);
  return found;
}

describe('intent import body ceiling', () => {
  it('accepts a body under the bound and reports its real serialized size', () => {
    const body = { idempotencyKey: 'k', localRevision: 'r', overlay: OVERLAY as unknown as Record<string, unknown> };
    expect(intentImportBodyBytes(body)).toBe(Buffer.byteLength(JSON.stringify(body), 'utf-8'));
    expect(() => assertIntentImportBodyWithinCeiling(body, '/repo/.coredoc/intent.json')).not.toThrow();
  });

  it('refuses an oversize body naming the exact bound, before anything is sent', () => {
    const body = {
      idempotencyKey: 'k',
      localRevision: 'r',
      overlay: { filler: 'x'.repeat(MAX_INTENT_IMPORT_BODY_BYTES) } as unknown as Record<string, unknown>,
    };
    expect(() => assertIntentImportBodyWithinCeiling(body, '/repo/.coredoc/intent.json')).toThrow(
      new RegExp(`${MAX_INTENT_IMPORT_BODY_BYTES}-byte`),
    );
    expect(() => assertIntentImportBodyWithinCeiling(body, '/repo/.coredoc/intent.json')).toThrow(/Nothing was sent/);
  });
});

describe('runIntentBootstrapCheck', () => {
  let dir: string;
  let repoRoot: string;
  let configPath: string;
  let transport: IntentBootstrapTransport;

  function buildConfig(intent?: { mode: 'cloud'; workspaceId: string }): RuntimeConfig {
    const project = {
      id: PROJECT,
      name: 'Sample',
      repos: [{ name: REPO, path: repoRoot }],
      ...(intent ? { intent } : {}),
    };
    const raw = {
      version: '2.0',
      projects: [project],
      output: { dir: './out', format: 'json' },
      parserStorage: './parsers',
      agentMode: 'auto',
    };
    writeFileSync(configPath, `${JSON.stringify(raw, null, 2)}\n`);
    return {
      ...raw,
      configPath,
      configDir: dir,
      resolvedRepoPaths: new Map([[`${PROJECT}/${REPO}`, repoRoot]]),
      resolvedOutputDir: join(dir, 'out'),
      resolvedParserStorage: join(dir, 'parsers'),
    } as unknown as RuntimeConfig;
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'intent-bootstrap-'));
    repoRoot = join(dir, REPO);
    mkdirSync(join(repoRoot, '.coredoc'), { recursive: true });
    writeFileSync(join(repoRoot, '.coredoc', 'intent.json'), `${JSON.stringify(OVERLAY, null, 2)}\n`);
    configPath = join(dir, 'coredoc.config.json');
    transport = { preflight: async () => preflight() };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('passes every check on a ready project and asks the server once', async () => {
    let calls = 0;
    const result = await runIntentBootstrapCheck({
      config: buildConfig(),
      projectId: PROJECT,
      workspaceId: WORKSPACE,
      transport: {
        preflight: async (workspaceId) => {
          calls += 1;
          expect(workspaceId).toBe(WORKSPACE);
          return preflight();
        },
      },
    });

    expect(calls).toBe(1);
    expect(result.ok).toBe(true);
    expect(checkFor(result.checks, BootstrapCheckId.Overlay).status).toBe(BootstrapCheckStatus.Pass);
    expect(checkFor(result.checks, BootstrapCheckId.ImportBody).status).toBe(BootstrapCheckStatus.Pass);
    expect(checkFor(result.checks, BootstrapCheckId.Cutover).status).toBe(BootstrapCheckStatus.Pass);
    expect(checkFor(result.checks, BootstrapCheckId.WorkspaceEmpty).status).toBe(BootstrapCheckStatus.Pass);
    expect(checkFor(result.checks, BootstrapCheckId.RepoIdentity).status).toBe(BootstrapCheckStatus.Pass);
    // No packet was asked for, so its check is skipped rather than invented.
    expect(checkFor(result.checks, BootstrapCheckId.Packet).status).toBe(BootstrapCheckStatus.Skipped);
  });

  it('reports a missing overlay and still answers the workspace questions', async () => {
    rmSync(join(repoRoot, '.coredoc', 'intent.json'));
    const result = await runIntentBootstrapCheck({
      config: buildConfig(),
      projectId: PROJECT,
      workspaceId: WORKSPACE,
      transport,
    });

    expect(result.ok).toBe(false);
    expect(checkFor(result.checks, BootstrapCheckId.Overlay).status).toBe(BootstrapCheckStatus.Fail);
    expect(checkFor(result.checks, BootstrapCheckId.ImportBody).status).toBe(BootstrapCheckStatus.Skipped);
    // The point of a readiness verb: one run shows everything, so the
    // maintainer is not fixing one problem per invocation.
    expect(checkFor(result.checks, BootstrapCheckId.WorkspaceEmpty).status).toBe(BootstrapCheckStatus.Pass);
  });

  it('fails on a non-empty workspace with the counts that are in the way', async () => {
    const result = await runIntentBootstrapCheck({
      config: buildConfig(),
      projectId: PROJECT,
      workspaceId: WORKSPACE,
      transport: {
        preflight: async () => preflight({ empty: false, content: { domains: 2, features: 1, items: 7 } }),
      },
    });

    expect(result.ok).toBe(false);
    const check = checkFor(result.checks, BootstrapCheckId.WorkspaceEmpty);
    expect(check.status).toBe(BootstrapCheckStatus.Fail);
    expect(check.detail).toContain('domains: 2');
    expect(check.detail).toContain('items: 7');
  });

  it('fails when an anchor names a repo identity the workspace does not carry', async () => {
    const result = await runIntentBootstrapCheck({
      config: buildConfig(),
      projectId: PROJECT,
      workspaceId: WORKSPACE,
      transport: {
        preflight: async () =>
          preflight({ intentRepoKeys: ['other-repo'], registeredRepoIdentities: ['other-repo (other-repo)'] }),
      },
    });

    expect(result.ok).toBe(false);
    const check = checkFor(result.checks, BootstrapCheckId.RepoIdentity);
    expect(check.status).toBe(BootstrapCheckStatus.Fail);
    expect(check.detail).toContain(REPO);
    expect(check.detail).toContain('other-repo (other-repo)');
  });

  it('accepts a rerun into the same workspace and refuses one into a different workspace', async () => {
    const rerun = await runIntentBootstrapCheck({
      config: buildConfig({ mode: 'cloud', workspaceId: WORKSPACE }),
      projectId: PROJECT,
      workspaceId: WORKSPACE,
      transport,
    });
    expect(checkFor(rerun.checks, BootstrapCheckId.Cutover).status).toBe(BootstrapCheckStatus.Pass);

    const retarget = await runIntentBootstrapCheck({
      config: buildConfig({ mode: 'cloud', workspaceId: 'ws_someone_else' }),
      projectId: PROJECT,
      workspaceId: WORKSPACE,
      transport,
    });
    const check = checkFor(retarget.checks, BootstrapCheckId.Cutover);
    expect(check.status).toBe(BootstrapCheckStatus.Fail);
    expect(check.detail).toContain('ws_someone_else');
    expect(retarget.ok).toBe(false);
  });

  it('reports an unreachable workspace and skips what depends on it', async () => {
    const result = await runIntentBootstrapCheck({
      config: buildConfig(),
      projectId: PROJECT,
      workspaceId: WORKSPACE,
      transport: {
        preflight: async () => {
          throw new IntentApiError(
            'intent bootstrap-check',
            403,
            { code: 'forbidden', message: 'Not a member of this workspace', path: [] },
            '{"code":"forbidden"}',
          );
        },
      },
    });

    expect(result.ok).toBe(false);
    expect(checkFor(result.checks, BootstrapCheckId.Workspace).detail).toContain('Not a member of this workspace');
    expect(checkFor(result.checks, BootstrapCheckId.WorkspaceEmpty).status).toBe(BootstrapCheckStatus.Skipped);
    expect(checkFor(result.checks, BootstrapCheckId.RepoIdentity).status).toBe(BootstrapCheckStatus.Skipped);
  });

  it('validates a brownfield packet with core’s own parser when --input is given', async () => {
    const packetPath = join(dir, 'packet.json');
    writeFileSync(packetPath, `${JSON.stringify(PACKET, null, 2)}\n`);
    const ok = await runIntentBootstrapCheck({
      config: buildConfig(),
      projectId: PROJECT,
      workspaceId: WORKSPACE,
      input: packetPath,
      transport,
    });
    expect(checkFor(ok.checks, BootstrapCheckId.Packet).status).toBe(BootstrapCheckStatus.Pass);
    expect(ok.ok).toBe(true);

    // A class-C source may not frame a product candidate — core's rule, not a
    // copy of it here.
    const badPath = join(dir, 'bad-packet.json');
    writeFileSync(
      badPath,
      `${JSON.stringify({ ...PACKET, sources: [{ ...PACKET.sources[0], class: 'C' }] }, null, 2)}\n`,
    );
    const bad = await runIntentBootstrapCheck({
      config: buildConfig(),
      projectId: PROJECT,
      workspaceId: WORKSPACE,
      input: badPath,
      transport,
    });
    expect(checkFor(bad.checks, BootstrapCheckId.Packet).status).toBe(BootstrapCheckStatus.Fail);
    expect(bad.ok).toBe(false);
  });

  it('throws rather than reporting when the project itself is unknown', async () => {
    await expect(
      runIntentBootstrapCheck({
        config: buildConfig(),
        projectId: 'no-such-project',
        workspaceId: WORKSPACE,
        transport,
      }),
    ).rejects.toThrow();
  });
});
