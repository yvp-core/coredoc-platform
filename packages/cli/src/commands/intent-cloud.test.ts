/**
 * `coredoc intent export` at the CLI seam, and the §12 error rendering.
 *
 * The transport is injected, so these prove the FLOW — pick the route for the
 * format, write the document verbatim, report what was written — without a
 * server. What the server returns is proven by
 * `apps/server/.../intent-import-export.postgres.integration.test.ts`.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IntentApiError } from '../sync/workspace-api.js';
import {
  IntentExportFormat,
  formatIntentApiError,
  parseIntentExportFormat,
  printIntentExportResult,
  runIntentExport,
  type IntentCloudTransport,
} from './intent-cloud.js';

const WORKSPACE = 'ws_export_1';

/** C0/C1 and DEL, minus the newline the renderers use for their own structure. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: asserting control bytes are absent.
const CONTROL_CHARS_EXCEPT_NEWLINE = /[\x00-\x09\x0b-\x1f\x7f-\x9f]/;

const BACKUP = {
  formatVersion: 1,
  generatedAt: '2026-09-02T00:00:00.000Z',
  contentHash: 'a'.repeat(64),
  content: { workspaceId: WORKSPACE, items: [] },
};

const WORKSPACE_DOCUMENT = {
  formatVersion: 1,
  source: { ref: 'coredoc-workspace-export', revision: 'b'.repeat(64) },
  domains: [{ id: 'ordering', title: 'Ordering' }],
  features: [],
  items: [{ id: 'br-orders-never-exceed-stock' }, { id: 'cap-widget-ordering' }],
};

describe('intent cloud commands', () => {
  let dir: string;
  let calls: string[];
  let transport: IntentCloudTransport;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'intent-cloud-'));
    calls = [];
    transport = {
      fetchExport: async (workspaceId) => {
        calls.push(`backup:${workspaceId}`);
        return BACKUP;
      },
      fetchWorkspaceExport: async (workspaceId) => {
        calls.push(`workspace:${workspaceId}`);
        return WORKSPACE_DOCUMENT;
      },
    };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('parseIntentExportFormat', () => {
    it('defaults to backup and accepts both named formats', () => {
      expect(parseIntentExportFormat(undefined)).toBe(IntentExportFormat.Backup);
      expect(parseIntentExportFormat('backup')).toBe(IntentExportFormat.Backup);
      expect(parseIntentExportFormat('workspace')).toBe(IntentExportFormat.Workspace);
    });

    it('refuses an unknown format, naming the accepted ones', () => {
      expect(() => parseIntentExportFormat('overlay')).toThrow(/--format must be one of backup, workspace/);
    });
  });

  describe('runIntentExport', () => {
    it('writes the backup projection verbatim to the explicit path by default, creating parents', async () => {
      const out = join(dir, 'nested', 'intent-export.json');
      const result = await runIntentExport({ workspaceId: WORKSPACE, out, transport });

      expect(calls).toEqual([`backup:${WORKSPACE}`]);
      expect(result).toMatchObject({
        format: IntentExportFormat.Backup,
        outPath: out,
        contentHash: 'a'.repeat(64),
        generatedAt: '2026-09-02T00:00:00.000Z',
      });
      expect(JSON.parse(readFileSync(out, 'utf-8'))).toEqual(BACKUP);
    });

    it('fetches and writes the workspace document for --format workspace', async () => {
      const out = join(dir, 'workspace.json');
      const result = await runIntentExport({
        workspaceId: WORKSPACE,
        out,
        format: IntentExportFormat.Workspace,
        transport,
      });

      expect(calls).toEqual([`workspace:${WORKSPACE}`]);
      expect(result).toMatchObject({ format: IntentExportFormat.Workspace, revision: 'b'.repeat(64), items: 2 });
      expect(JSON.parse(readFileSync(out, 'utf-8'))).toEqual(WORKSPACE_DOCUMENT);
    });
  });

  describe('printIntentExportResult', () => {
    it('reports the format and strips control characters from server-derived values', () => {
      const lines: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((line: string) => {
        lines.push(line);
      });
      printIntentExportResult({
        format: IntentExportFormat.Workspace,
        workspaceId: WORKSPACE,
        outPath: '/tmp/workspace.json',
        bytes: 10,
        revision: 'rev\x1b]0;pwned\x07',
        items: 2,
      });
      const rendered = lines.join('\n');
      expect(rendered).toContain('format:      workspace');
      expect(rendered).toContain('items:       2');
      expect(rendered).not.toMatch(CONTROL_CHARS_EXCEPT_NEWLINE);
    });
  });

  describe('formatIntentApiError', () => {
    it('prints code, message and the exact field path, untruncated', () => {
      const rendered = formatIntentApiError(
        new IntentApiError(
          'intent export',
          400,
          {
            code: 'content_email_shaped',
            message: 'Intent content must not contain an email address; actor identity comes from the auth token',
            path: ['document', 'items', '3', 'sources', '0', 'ref'],
          },
          '',
        ),
      );
      expect(rendered).toContain('content_email_shaped');
      expect(rendered).toContain('document.items.3.sources.0.ref');
      expect(rendered).toContain('actor identity comes from the auth token');
    });

    it('prints every details entry rather than only the first', () => {
      const rendered = formatIntentApiError(
        new IntentApiError(
          'intent release',
          400,
          {
            code: 'invalid_request',
            message: 'first problem',
            path: ['items', '0', 'domainId'],
            details: [
              { code: 'invalid_request', message: 'first problem', path: ['items', '0', 'domainId'] },
              { code: 'invalid_request', message: 'second problem', path: ['items', '2', 'featureId'] },
            ],
          },
          '',
        ),
      );
      expect(rendered).toContain('items.0.domainId');
      expect(rendered).toContain('items.2.featureId');
      expect(rendered).toContain('second problem');
    });

    it('shows a non-contract body as it arrived instead of a generic hint', () => {
      const rendered = formatIntentApiError(
        new IntentApiError('intent export', 502, undefined, '<html>upstream connect error</html>'),
      );
      expect(rendered).toContain('HTTP 502');
      expect(rendered).toContain('upstream connect error');
    });

    /**
     * "Verbatim" (spec §12) stops at control bytes. A refusal quotes the
     * offending content back, that content is agent-authored, and this
     * renderer writes it to the terminal a maintainer is reading the refusal
     * on. `\x1b]0;` is an OSC title-set; `\x9b` is 8-bit CSI.
     */
    it('strips control characters from every server-derived string it prints', () => {
      const rendered = formatIntentApiError(
        new IntentApiError(
          'intent export',
          400,
          {
            code: 'bad\x1bcode',
            message: 'refused \x1b]0;pwned\x07 and \x9b31m red',
            path: ['document', 'items\x1b[2J', '0'],
            details: [{ code: 'd\x9bcode', message: 'detail \x1b[31m', path: ['document\x07'] }],
          },
          '',
        ),
      );
      // Newlines are the renderer's OWN line structure, not server text.
      expect(rendered).not.toMatch(CONTROL_CHARS_EXCEPT_NEWLINE);
      // The human-readable content survives: only the control bytes are gone.
      expect(rendered).toContain('badcode');
      expect(rendered).toContain('pwned');
      expect(rendered).toContain('document.items[2J.0');
    });

    it('strips control characters from a non-contract body without collapsing its lines', () => {
      const rendered = formatIntentApiError(
        new IntentApiError('intent export', 502, undefined, 'line one \x1b]0;x\x07\nline two \x9b31m'),
      );
      expect(rendered).not.toMatch(CONTROL_CHARS_EXCEPT_NEWLINE);
      expect(rendered).toContain('    line one');
      expect(rendered).toContain('    line two');
    });
  });
});
