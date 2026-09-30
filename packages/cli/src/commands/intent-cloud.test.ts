/**
 * `coredoc intent import` / `intent export` at the CLI seam: the cutover marker,
 * the crash-recovery rerun, and the §12 error rendering.
 *
 * The transport is injected, so these prove the FLOW — read the overlay, derive
 * a stable key, POST, then write the marker — without a server. What the server
 * does with the request is proven by
 * `apps/server/.../intent-import-export.postgres.integration.test.ts`.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RuntimeConfig } from '@coredoc/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IntentApiError, type CloudIntentImportResult, type ImportIntentOverlayBody } from '../sync/workspace-api.js';
import {
  formatIntentApiError,
  intentImportIdempotencyKey,
  printIntentImportResult,
  runIntentExport,
  runIntentImport,
  type IntentCloudTransport,
} from './intent-cloud.js';

const WORKSPACE = 'ws_import_1';
const PROJECT = 'sample-project';

/** C0/C1 and DEL, minus the newline the renderers use for their own structure. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: asserting control bytes are absent.
const CONTROL_CHARS_EXCEPT_NEWLINE = /[\x00-\x09\x0b-\x1f\x7f-\x9f]/;

/** A real, minimal v2 overlay: two domains, two items, one anchor, one relation to drop. */
const OVERLAY = {
  schemaVersion: 2,
  projectId: PROJECT,
  domains: [
    { id: 'ordering', title: 'Ordering', statement: 'Placing and refusing widget orders.' },
    { id: 'stock', title: 'Stock' },
  ],
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
          repo: 'sample-repo',
          nodeId: 'aaaa:function:src/widgets/order.ts:placeOrder',
          nodeType: 'function',
          capturedVersionedId: 'aaaa:function:src/widgets/order.ts:placeOrder@1111',
          rationale: 'Entry point that performs the ordering outcome',
        },
      ],
    },
    {
      id: 'br-orders-never-exceed-stock',
      kind: 'business_rule',
      domain: 'stock',
      title: 'Orders never exceed stock',
      statement: 'An order beyond available stock is refused.',
      authority: 'candidate',
      sources: [{ kind: 'issue', ref: 'tracker/WID-14', localId: 'BR-3' }],
      payload: {
        condition: 'An order requests more units than the warehouse holds',
        requiredOutcome: 'The order is refused and no stock is reserved',
        observer: 'Store operator',
      },
    },
  ],
  relations: [{ from: 'br-orders-never-exceed-stock', type: 'governs', to: 'cap-widget-ordering' }],
};

function importResult(overrides: Partial<CloudIntentImportResult> = {}): CloudIntentImportResult {
  return {
    formatVersion: 1,
    workspaceId: WORKSPACE,
    localRevision: 'unused-in-assertions',
    projectId: PROJECT,
    createdDomains: [
      { id: 'ordering', title: 'Ordering' },
      { id: 'stock', title: 'Stock' },
    ],
    importedItems: [
      { id: 'cap-widget-ordering', authority: 'accepted', domainId: 'ordering' },
      { id: 'br-orders-never-exceed-stock', authority: 'candidate', domainId: 'stock' },
    ],
    importedSourceCount: 2,
    importedAnchorCount: 1,
    skippedAnchors: [],
    droppedRelations: [{ from: 'br-orders-never-exceed-stock', type: 'governs', to: 'cap-widget-ordering' }],
    registeredRepoIdentities: ['sample-repo (sample-repo)'],
    ...overrides,
  };
}

describe('intent cloud commands', () => {
  let dir: string;
  let repoRoot: string;
  let configPath: string;
  let calls: Array<{ workspaceId: string; body: ImportIntentOverlayBody }>;
  let transport: IntentCloudTransport;

  function buildConfig(intent?: { mode: 'cloud'; workspaceId: string }): RuntimeConfig {
    const project = {
      id: PROJECT,
      name: 'Sample',
      repos: [{ name: 'sample-repo', path: repoRoot }],
      ...(intent ? { intent } : {}),
    };
    const raw = {
      version: '2.0',
      projects: [project, { id: 'other', name: 'Other', repos: [] }],
      output: { dir: './out', format: 'json' },
      parserStorage: './parsers',
      agentMode: 'auto',
    };
    writeFileSync(configPath, `${JSON.stringify(raw, null, 2)}\n`);
    return {
      ...raw,
      configPath,
      configDir: dir,
      resolvedRepoPaths: new Map([[`${PROJECT}/sample-repo`, repoRoot]]),
      resolvedOutputDir: join(dir, 'out'),
      resolvedParserStorage: join(dir, 'parsers'),
    } as unknown as RuntimeConfig;
  }

  function readMarker(): unknown {
    const config = JSON.parse(readFileSync(configPath, 'utf-8')) as {
      projects: Array<{ id: string; intent?: unknown }>;
    };
    return config.projects.find((project) => project.id === PROJECT)?.intent;
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'intent-cloud-'));
    repoRoot = join(dir, 'sample-repo');
    mkdirSync(join(repoRoot, '.coredoc'), { recursive: true });
    writeFileSync(join(repoRoot, '.coredoc', 'intent.json'), `${JSON.stringify(OVERLAY, null, 2)}\n`);
    configPath = join(dir, 'coredoc.config.json');

    calls = [];
    transport = {
      importOverlay: async (workspaceId, body) => {
        calls.push({ workspaceId, body });
        return importResult();
      },
      fetchExport: async () => ({
        formatVersion: 1,
        generatedAt: '2026-09-02T00:00:00.000Z',
        contentHash: 'a'.repeat(64),
        content: { workspaceId: WORKSPACE, items: [] },
      }),
    };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('runIntentImport', () => {
    it('posts the overlay and writes the cutover marker', async () => {
      const result = await runIntentImport({
        yes: true,
        config: buildConfig(),
        projectId: PROJECT,
        workspaceId: WORKSPACE,
        transport,
      });

      expect(calls).toHaveLength(1);
      expect(calls[0].workspaceId).toBe(WORKSPACE);
      expect(calls[0].body.overlay).toMatchObject({ schemaVersion: 2, projectId: PROJECT });
      expect(calls[0].body.localRevision).toMatch(/^[a-f0-9]{64}$/);
      expect(calls[0].body.idempotencyKey).toBe(intentImportIdempotencyKey(result.localRevision));

      expect(readMarker()).toEqual({ mode: 'cloud', workspaceId: WORKSPACE });
      expect(result.markerAlreadyPresent).toBe(false);
    });

    it('derives the same idempotency key from the same overlay, run after run', async () => {
      const first = await runIntentImport({
        yes: true,
        config: buildConfig(),
        projectId: PROJECT,
        workspaceId: WORKSPACE,
        transport,
      });
      const second = await runIntentImport({
        yes: true,
        config: buildConfig(),
        projectId: PROJECT,
        workspaceId: WORKSPACE,
        transport,
      });
      // Same key is what makes the server replay rather than import twice.
      expect(second.idempotencyKey).toBe(first.idempotencyKey);
      expect(calls[1].body.idempotencyKey).toBe(calls[0].body.idempotencyKey);
    });

    it('completes the marker write on a rerun after a crash between POST and config write', async () => {
      // The crash: the server committed, the marker never landed.
      await expect(
        runIntentImport({
          yes: true,
          config: buildConfig(),
          projectId: PROJECT,
          workspaceId: WORKSPACE,
          transport: {
            ...transport,
            importOverlay: async (workspaceId, body) => {
              calls.push({ workspaceId, body });
              throw new Error('connection reset after the server committed');
            },
          },
        }),
      ).rejects.toThrow(/connection reset/);
      expect(readMarker()).toBeUndefined();

      // The designated recovery: rerun the identical command. Same key, the
      // server replays its stored result, the marker write completes.
      const recovered = await runIntentImport({
        yes: true,
        config: buildConfig(),
        projectId: PROJECT,
        workspaceId: WORKSPACE,
        transport,
      });
      expect(recovered.idempotencyKey).toBe(calls[0].body.idempotencyKey);
      expect(readMarker()).toEqual({ mode: 'cloud', workspaceId: WORKSPACE });
    });

    it('is a no-op rerun once the marker already names the same workspace', async () => {
      const result = await runIntentImport({
        yes: true,
        config: buildConfig({ mode: 'cloud', workspaceId: WORKSPACE }),
        projectId: PROJECT,
        workspaceId: WORKSPACE,
        transport,
      });
      expect(result.markerAlreadyPresent).toBe(true);
      expect(readMarker()).toEqual({ mode: 'cloud', workspaceId: WORKSPACE });
    });

    it('refuses to re-point a cut-over project at a different workspace', async () => {
      await expect(
        runIntentImport({
          yes: true,
          config: buildConfig({ mode: 'cloud', workspaceId: 'ws_other' }),
          projectId: PROJECT,
          workspaceId: WORKSPACE,
          transport,
        }),
      ).rejects.toThrow(/already cut over to workspace ws_other/);
      expect(calls).toHaveLength(0);
    });

    it('refuses when there is no overlay to import', async () => {
      rmSync(join(repoRoot, '.coredoc', 'intent.json'));
      await expect(
        runIntentImport({ yes: true, config: buildConfig(), projectId: PROJECT, workspaceId: WORKSPACE, transport }),
      ).rejects.toThrow(/nothing to import/);
      expect(calls).toHaveLength(0);
      expect(readMarker()).toBeUndefined();
    });

    it('refuses an invalid overlay locally rather than uploading it', async () => {
      writeFileSync(
        join(repoRoot, '.coredoc', 'intent.json'),
        JSON.stringify({ ...OVERLAY, items: [{ ...OVERLAY.items[0], domain: 'undeclared' }] }),
      );
      await expect(
        runIntentImport({ yes: true, config: buildConfig(), projectId: PROJECT, workspaceId: WORKSPACE, transport }),
      ).rejects.toThrow(/is invalid/);
      expect(calls).toHaveLength(0);
    });

    it('does not write the marker when the server refuses', async () => {
      await expect(
        runIntentImport({
          yes: true,
          config: buildConfig(),
          projectId: PROJECT,
          workspaceId: WORKSPACE,
          transport: {
            ...transport,
            importOverlay: async () => {
              throw new IntentApiError(
                'intent import',
                409,
                {
                  code: 'workspace_not_empty',
                  message: 'Workspace already holds intent content (items: 4).',
                  path: [],
                },
                '',
              );
            },
          },
        }),
      ).rejects.toBeInstanceOf(IntentApiError);
      expect(readMarker()).toBeUndefined();
    });
  });

  /**
   * Import is a ONE-WAY authority cutover with no un-cutover verb, so it must
   * not happen because someone pasted a command with the wrong `-w`.
   */
  describe('runIntentImport confirmation', () => {
    it('refuses without --yes, and neither uploads nor writes the marker', async () => {
      await expect(
        runIntentImport({ config: buildConfig(), projectId: PROJECT, workspaceId: WORKSPACE, transport }),
      ).rejects.toThrow(/Re-run with --yes/);
      expect(calls).toHaveLength(0);
      expect(readMarker()).toBeUndefined();
    });

    it('describes what the cutover would do, with the real counts from the overlay', async () => {
      const refusal = await runIntentImport({
        config: buildConfig(),
        projectId: PROJECT,
        workspaceId: WORKSPACE,
        transport,
      }).catch((error: unknown) => (error as Error).message);

      expect(refusal).toContain(WORKSPACE);
      expect(refusal).toContain(PROJECT);
      expect(refusal).toContain('items:        2');
      expect(refusal).toContain('relations:    1');
      expect(refusal).toContain('domains:      2');
      expect(refusal).toContain('code anchors: 1');
      expect(refusal).toContain('`coredoc intent capture` fails fast');
    });

    it('refuses an absent overlay BEFORE it asks for confirmation', async () => {
      // Nothing to confirm: there is no cutover to describe.
      rmSync(join(repoRoot, '.coredoc', 'intent.json'));
      await expect(
        runIntentImport({ config: buildConfig(), projectId: PROJECT, workspaceId: WORKSPACE, transport }),
      ).rejects.toThrow(/nothing to import/);
    });
  });

  describe('printIntentImportResult', () => {
    it('strips control characters from every value the server echoed back', () => {
      const lines: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((line?: unknown) => {
        lines.push(String(line));
      });
      printIntentImportResult({
        projectId: PROJECT,
        workspaceId: 'ws\x1b]0;pwned\x07',
        repo: 'repo\x9b31m',
        intentPath: '/tmp/intent.json',
        localRevision: 'rev\x1b[2J',
        idempotencyKey: 'key',
        markerAlreadyPresent: false,
        result: {
          formatVersion: 1,
          workspaceId: 'ws',
          localRevision: 'rev',
          projectId: PROJECT,
          createdDomains: [{ id: 'dom\x1b[31m', title: 'T' }],
          importedItems: [{ id: 'i1', authority: 'accepted\x07', domainId: 'dom' }],
          importedSourceCount: 1,
          importedAnchorCount: 0,
          skippedAnchors: [{ repo: 'r\x1b[0m', reason: 'unknown\x9b', anchorCount: 1, itemIds: ['i\x1b1'] }],
          droppedRelations: [{ from: 'a\x07', type: 'refines\x1b', to: 'b' }],
          registeredRepoIdentities: ['id\x1b[1m'],
        },
      });
      expect(lines.join('\n')).not.toMatch(CONTROL_CHARS_EXCEPT_NEWLINE);
    });
  });

  describe('runIntentExport', () => {
    it('writes the document verbatim to the explicit path, creating parents', async () => {
      const out = join(dir, 'nested', 'intent-export.json');
      const result = await runIntentExport({ workspaceId: WORKSPACE, out, transport });

      expect(result.outPath).toBe(out);
      expect(result.contentHash).toBe('a'.repeat(64));
      const written = JSON.parse(readFileSync(out, 'utf-8')) as Record<string, unknown>;
      expect(written).toEqual({
        formatVersion: 1,
        generatedAt: '2026-09-02T00:00:00.000Z',
        contentHash: 'a'.repeat(64),
        content: { workspaceId: WORKSPACE, items: [] },
      });
    });
  });

  describe('formatIntentApiError', () => {
    it('prints code, message and the exact field path, untruncated', () => {
      const rendered = formatIntentApiError(
        new IntentApiError(
          'intent import',
          400,
          {
            code: 'content_email_shaped',
            message: 'Intent content must not contain an email address; actor identity comes from the auth token',
            path: ['overlay', 'items', '3', 'sources', '0', 'ref'],
          },
          '',
        ),
      );
      expect(rendered).toContain('content_email_shaped');
      expect(rendered).toContain('overlay.items.3.sources.0.ref');
      expect(rendered).toContain('actor identity comes from the auth token');
    });

    it('prints every details entry rather than only the first', () => {
      const rendered = formatIntentApiError(
        new IntentApiError(
          'intent import',
          400,
          {
            code: 'import_overlay_invalid',
            message: 'first problem',
            path: ['overlay', 'items', '0', 'domain'],
            details: [
              { code: 'import_overlay_invalid', message: 'first problem', path: ['overlay', 'items', '0', 'domain'] },
              { code: 'import_overlay_invalid', message: 'second problem', path: ['overlay', 'relations', '2', 'to'] },
            ],
          },
          '',
        ),
      );
      expect(rendered).toContain('overlay.items.0.domain');
      expect(rendered).toContain('overlay.relations.2.to');
      expect(rendered).toContain('second problem');
    });

    it('shows a non-contract body as it arrived instead of a generic hint', () => {
      const rendered = formatIntentApiError(
        new IntentApiError('intent import', 502, undefined, '<html>upstream connect error</html>'),
      );
      expect(rendered).toContain('HTTP 502');
      expect(rendered).toContain('upstream connect error');
    });

    /**
     * "Verbatim" (spec §12) stops at control bytes. A refusal quotes the
     * offending overlay content back, that content is agent-authored, and this
     * renderer writes it to the terminal a maintainer is reading the refusal
     * on. `\x1b]0;` is an OSC title-set; `\x9b` is 8-bit CSI.
     */
    it('strips control characters from every server-derived string it prints', () => {
      const rendered = formatIntentApiError(
        new IntentApiError(
          'intent import',
          400,
          {
            // biome-ignore lint/suspicious/noControlCharactersInRegex: hostile fixture, not a pattern.
            code: 'bad\x1bcode',
            message: 'refused \x1b]0;pwned\x07 and \x9b31m red',
            path: ['overlay', 'items\x1b[2J', '0'],
            details: [{ code: 'd\x9bcode', message: 'detail \x1b[31m', path: ['overlay\x07'] }],
          },
          '',
        ),
      );
      // Newlines are the renderer's OWN line structure, not server text.
      expect(rendered).not.toMatch(CONTROL_CHARS_EXCEPT_NEWLINE);
      // The human-readable content survives: only the control bytes are gone.
      expect(rendered).toContain('badcode');
      expect(rendered).toContain('pwned');
      expect(rendered).toContain('overlay.items[2J.0');
    });

    it('strips control characters from a non-contract body without collapsing its lines', () => {
      const rendered = formatIntentApiError(
        new IntentApiError('intent import', 502, undefined, 'line one \x1b]0;x\x07\nline two \x9b31m'),
      );
      expect(rendered).not.toMatch(CONTROL_CHARS_EXCEPT_NEWLINE);
      expect(rendered).toContain('    line one');
      expect(rendered).toContain('    line two');
    });
  });
});
