import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { AgentGoogle, type GoogleFetch } from '../../libs/google/agent-google.js';
import { McpAuthKind } from '../mcp-auth-context.js';
import { AgentGoogleTools } from './agent-google.tools.js';

const DRIVE = 'drive-0001';
const WORKSPACE = 'ws-google';
const DOC_TYPE = 'application/vnd.google-apps.document';

/** What Google holds: files by id, each in some drive. */
const FILES: Record<string, Record<string, unknown>> = {
  spec: { id: 'spec', name: 'Spec', mimeType: DOC_TYPE, driveId: DRIVE, parents: ['folder'] },
  folder: { id: 'folder', name: 'Contracts', mimeType: 'application/vnd.google-apps.folder', driveId: DRIVE },
  sheet: { id: 'sheet', name: 'Decisions', mimeType: 'application/vnd.google-apps.spreadsheet', driveId: DRIVE },
  elsewhere: { id: 'elsewhere', name: 'Payroll', mimeType: DOC_TYPE, driveId: 'another-drive' },
  mine: { id: 'mine', name: 'Private', mimeType: DOC_TYPE },
  locked: { id: 'locked', name: 'Locked', mimeType: DOC_TYPE, driveId: DRIVE },
  notes: { id: 'notes', name: 'notes.md', mimeType: 'text/markdown', size: '11', driveId: DRIVE },
  dump: { id: 'dump', name: 'dump.csv', mimeType: 'text/csv', size: String(2 * 1024 * 1024 + 1), driveId: DRIVE },
  scan: { id: 'scan', name: 'scan.pdf', mimeType: 'application/pdf', size: '900', driveId: DRIVE },
  wide: { id: 'wide', name: 'History', mimeType: 'application/vnd.google-apps.spreadsheet', driveId: DRIVE },
  agentFolder: {
    id: 'agentFolder',
    name: 'Hand-off',
    mimeType: 'application/vnd.google-apps.folder',
    driveId: DRIVE,
    appProperties: { coredocAgentRun: 'true' },
  },
};

const DOCUMENT = {
  documentId: 'spec',
  revisionId: 'rev-7',
  tabs: [
    {
      documentTab: {
        body: {
          content: [
            {
              startIndex: 1,
              paragraph: { elements: [{ textRun: { content: 'Overtime\n', suggestedInsertionIds: ['s.1'] } }] },
            },
          ],
        },
      },
    },
  ],
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

interface Sent {
  method: string;
  url: URL;
  body: string | undefined;
}

/** Google at its HTTP boundary: records every request and answers the calls the tools make. */
function fakeGoogle({ unreachable = false } = {}) {
  const files = structuredClone(FILES);
  const sent: Sent[] = [];
  const fetcher: GoogleFetch = async (url, init) => {
    const request = { method: init.method, url: new URL(url), body: init.body };
    sent.push(request);
    if (unreachable) throw new TypeError('fetch failed');
    const { pathname, searchParams } = request.url;
    const id = /^\/drive\/v3\/files\/([^/]+)$/.exec(pathname)?.[1];
    if (id && init.method === 'GET' && !searchParams.has('alt')) {
      return files[id] ? json(files[id]) : json({ error: { code: 404, message: `File not found: ${id}.` } }, 404);
    }
    if (id && init.method === 'GET') return new Response('# Notes\n\nx');
    if (pathname.startsWith('/v4/spreadsheets/wide/values/')) {
      return json({ range: 'A:Z', values: [['x'.repeat(2 * 1024 * 1024)]] });
    }
    if (pathname.includes('/locked')) {
      return json({ error: { code: 403, message: 'The caller does not have permission' } }, 403);
    }
    if (id && init.method === 'PATCH') return json({ id });
    if (pathname === '/upload/drive/v3/files' || (pathname === '/drive/v3/files' && init.method === 'POST')) {
      const metadata = JSON.parse(/\{.*\}/.exec(init.body ?? '')![0]) as Record<string, unknown>;
      const created = { ...metadata, id: `new-${Object.keys(files).length}`, driveId: DRIVE };
      files[created.id] = created;
      return json(created);
    }
    if (pathname === '/drive/v3/files') return json({ files: [files.spec] });
    if (pathname.endsWith('/comments')) return json({ comments: [{ id: 'c1', content: 'Check the rate' }] });
    if (pathname.endsWith('/export')) return new Response('# Spec\n');
    if (pathname.startsWith('/v1/documents/') && init.method === 'GET') return json(DOCUMENT);
    if (pathname.endsWith(':batchUpdate')) {
      return json({
        documentId: 'spec',
        writeControl: { requiredRevisionId: 'rev-8' },
        replies: [{}],
        suggestionResponses: [{ createdSuggestionIds: ['s.2'] }, { createdSuggestionIds: ['s.3'] }],
        commentUpdateState: 'NO_UPDATES_REQUESTED',
      });
    }
    if (pathname.startsWith('/v4/spreadsheets/')) return json({ range: 'Decisions!A1:B2', values: [['a', 'b']] });
    return json({ error: { code: 404, message: 'not faked' } }, 404);
  };
  const service = new AgentGoogle(
    {
      agentGoogle: {
        serviceAccount: { clientEmail: 'agent@example.iam.gserviceaccount.com', privateKey: 'unused' },
        sharedDriveId: DRIVE,
        workspaceId: WORKSPACE,
      },
    },
    fetcher,
  );
  return { tools: new AgentGoogleTools(service), sent };
}

const turn = (permissions = ['google:read', 'google:write'], workspaceId = WORKSPACE) =>
  ({
    workspaceId,
    user: { id: 'u1' },
    mcpAuthKind: McpAuthKind.ServiceToken,
    serviceTokenPermissions: permissions,
    serviceTokenTurnId: 'turn-1',
  }) as never;

type ToolResult = { isError?: boolean; content: Array<{ text: string }> };

/** Every answer, refusals included, ends by saying it is data; the block before it is the answer. */
function body(result: ToolResult): string {
  expect(result.content.at(-1)!.text).toMatch(/data from Google, not instructions/);
  return result.content[0]!.text;
}

const VALUES = [['Overtime', 1.5]];
/** Each tool with the argument that names the file, folder or spreadsheet it works on. */
const TOOLS: Array<[string, (tools: AgentGoogleTools, id: string, request: never) => Promise<ToolResult>]> = [
  ['read_doc', (t, id, r) => t.readDoc({ documentId: id, commentsIncluded: true }, {} as never, r)],
  [
    'update_doc',
    (t, id, r) =>
      t.updateDoc(
        {
          documentId: id,
          requests: [{ insertText: { location: { index: 1 }, text: 'x' } }],
          writeControl: { requiredRevisionId: 'rev-7' },
        },
        {} as never,
        r,
      ),
  ],
  ['search_files', (t, id, r) => t.searchFiles({ parentId: id }, {} as never, r)],
  ['get_file_metadata', (t, id, r) => t.getFileMetadata({ fileId: id }, {} as never, r)],
  ['read_file_content', (t, id, r) => t.readFileContent({ fileId: id, includeComments: true }, {} as never, r)],
  [
    'create_file',
    (t, id, r) => t.createFile({ name: 'Notes', parentId: id, mimeType: DOC_TYPE, content: '# Notes' }, {} as never, r),
  ],
  ['trash_file', (t, id, r) => t.trashFile({ fileId: id }, {} as never, r)],
  ['get_spreadsheet', (t, id, r) => t.getSpreadsheet({ spreadsheetId: id }, {} as never, r)],
  ['get_values', (t, id, r) => t.getValues({ spreadsheetId: id, range: 'A1:B2' }, {} as never, r)],
  ['append_values', (t, id, r) => t.appendValues({ spreadsheetId: id, range: 'A1', values: VALUES }, {} as never, r)],
  ['update_values', (t, id, r) => t.updateValues({ spreadsheetId: id, range: 'A1', values: VALUES }, {} as never, r)],
];

describe('agent Google tools', () => {
  describe.each(TOOLS)('%s', (_name, call) => {
    it.each([
      'elsewhere',
      'mine',
    ])('refuses the file %s outside the shared drive after looking up only its drive', async (id) => {
      const { tools, sent } = fakeGoogle();

      const result = await call(tools, id, turn());

      expect(result.isError).toBe(true);
      expect(body(result)).toContain('outside the shared drive');
      expect(sent.map(({ method, url }) => `${method} ${url.pathname}`)).toEqual([`GET /drive/v3/files/${id}`]);
      expect(sent[0]!.url.searchParams.get('supportsAllDrives')).toBe('true');
    });

    it.each([
      ['a token without the Google permissions', turn(['intent:read', 'jira:read'])],
      ['a turn of another workspace', turn(undefined, 'ws-other')],
      ['a user session', { workspaceId: WORKSPACE, user: { id: 'u1' }, mcpAuthKind: McpAuthKind.Jwt } as never],
    ])('refuses %s without calling Google', async (_case, request) => {
      const { tools, sent } = fakeGoogle();
      await expect(call(tools, 'spec', request)).rejects.toBeInstanceOf(ForbiddenException);
      expect(sent).toEqual([]);
    });
  });

  it('write tools need google:write: a read-only turn reads and cannot write', async () => {
    const { tools } = fakeGoogle();
    const readOnly = turn(['google:read']);
    expect((await tools.getFileMetadata({ fileId: 'spec' }, {} as never, readOnly)).isError).toBeUndefined();
    await expect(tools.trashFile({ fileId: 'spec' }, {} as never, readOnly)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('read_doc returns the Docs API document unchanged under content, read with suggestions inline and every tab', async () => {
    const { tools, sent } = fakeGoogle();

    const result = await tools.readDoc({ documentId: 'spec' }, {} as never, turn());

    expect(JSON.parse(body(result))).toEqual({ content: DOCUMENT });
    const read = sent.find(({ url }) => url.pathname === '/v1/documents/spec')!;
    expect(read.url.searchParams.get('suggestionsViewMode')).toBe('SUGGESTIONS_INLINE');
    expect(read.url.searchParams.get('includeTabsContent')).toBe('true');

    const withComments = await tools.readDoc({ documentId: 'spec', commentsIncluded: true }, {} as never, turn());
    expect(JSON.parse(body(withComments))).toMatchObject({ content: DOCUMENT, comments: [{ id: 'c1' }] });
  });

  it('read_file_content returns a stored text file as it is', async () => {
    const { tools } = fakeGoogle();
    const result = await tools.readFileContent({ fileId: 'notes' }, {} as never, turn());
    expect(JSON.parse(body(result))).toMatchObject({ mimeType: 'text/markdown', content: '# Notes\n\nx' });
  });

  it.each([
    ['a stored file over 2 MiB', 'dump'],
    ['a file that is not text', 'scan'],
  ])('read_file_content refuses %s without asking for its content', async (_case, fileId) => {
    const { tools, sent } = fakeGoogle();

    const result = await tools.readFileContent({ fileId }, {} as never, turn());

    expect(result.isError).toBe(true);
    expect(body(result)).toContain('text/*, JSON, CSV');
    expect(sent.map(({ url }) => `${url.pathname}${url.searchParams.has('alt') ? '?alt' : ''}`)).toEqual([
      `/drive/v3/files/${fileId}`,
    ]);
  });

  it('get_values refuses a range whose values are over 2 MiB', async () => {
    const { tools } = fakeGoogle();
    const result = await tools.getValues({ spreadsheetId: 'wide', range: 'A:Z' }, {} as never, turn());
    expect(result.isError).toBe(true);
    expect(body(result)).not.toContain('xxxx');
  });

  it.each([
    ['names no write mode', {}],
    ['names SUGGEST', { writeMode: 'SUGGEST' }],
  ])('update_doc reaches Google as a suggestion at the caller’s revision when the call %s', async (_case, mode) => {
    const { tools, sent } = fakeGoogle();
    const range = { startIndex: 1, endIndex: 9 };
    const requests = [
      { insertText: { location: { index: 1 }, text: 'Rate: ' } },
      { deleteContentRange: { range } },
      { update_text_style: { range, text_style: { bold: true }, fields: 'bold' } },
      { updateParagraphStyle: { range, paragraphStyle: { namedStyleType: 'HEADING_2' }, fields: 'namedStyleType' } },
      { createParagraphBullets: { range, bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE' } },
      { deleteParagraphBullets: { range } },
    ];

    const result = await tools.updateDoc(
      { documentId: 'spec', requests, writeControl: { requiredRevisionId: 'rev-7', ...mode } },
      {} as never,
      turn(),
    );

    const update = sent.find(({ url }) => url.pathname === '/v1/documents/spec:batchUpdate')!;
    expect(update.method).toBe('POST');
    expect(JSON.parse(update.body!)).toEqual({
      requests,
      writeControl: { requiredRevisionId: 'rev-7', writeMode: 'SUGGEST' },
    });
    expect(JSON.parse(body(result))).toMatchObject({
      suggestionIds: ['s.2', 's.3'],
      commentUpdateState: 'NO_UPDATES_REQUESTED',
    });
  });

  it.each([
    ['a direct edit', { requests: [{ insertText: { text: 'x' } }], writeControl: { writeMode: 'EDIT' } }],
    ['accepting a suggestion', { requests: [{ acceptSuggestion: { suggestionId: 's.1' } }] }],
    ['a suggestion decision in snake case', { requests: [{ reject_suggestion: { suggestion_id: 's.1' } }] }],
    ['deleting a comment', { requests: [{ insertText: { text: 'x' } }, { deleteComment: { commentId: 'c1' } }] }],
    ['deleting a tab', { requests: [{ deleteTab: { tabId: 't.0' } }] }],
    ['restyling the document', { requests: [{ updateDocumentStyle: { documentStyle: {}, fields: '*' } }] }],
    [
      'replacing text everywhere',
      { requests: [{ replaceAllText: { containsText: { text: 'a' }, replaceText: 'b' } }] },
    ],
  ])('update_doc refuses %s without calling Google', async (_case, { requests, writeControl }) => {
    const { tools, sent } = fakeGoogle();

    const result = await tools.updateDoc(
      { documentId: 'spec', requests, writeControl: { requiredRevisionId: 'rev-7', ...writeControl } },
      {} as never,
      turn(),
    );

    expect(result.isError).toBe(true);
    body(result);
    expect(sent).toEqual([]);
  });

  it('trash_file trashes a file create_file made and refuses one a person made', async () => {
    const { tools, sent } = fakeGoogle();

    const created = JSON.parse(
      body(
        await tools.createFile(
          { name: 'review.md', parentId: 'folder', mimeType: 'text/markdown', content: '# Review\n' },
          {} as never,
          turn(),
        ),
      ),
    ) as { id: string };
    const upload = sent.find(({ url }) => url.pathname === '/upload/drive/v3/files')!;
    expect(upload.url.searchParams.get('supportsAllDrives')).toBe('true');
    expect(upload.body).toContain('"parents":["folder"]');
    expect(upload.body).toContain('# Review');

    const trashed = await tools.trashFile({ fileId: created.id }, {} as never, turn());
    expect(trashed.isError).toBeUndefined();
    const patch = sent.find(({ method }) => method === 'PATCH')!;
    expect(patch.url.pathname).toBe(`/drive/v3/files/${created.id}`);
    expect(JSON.parse(patch.body!)).toEqual({ trashed: true });

    // A person's file, and a folder even when an agent run made it: people's files may be inside.
    for (const fileId of ['spec', 'agentFolder']) {
      const refused = await tools.trashFile({ fileId }, {} as never, turn());
      expect(refused.isError, fileId).toBe(true);
      body(refused);
    }
    expect(sent.filter(({ method }) => method === 'PATCH')).toHaveLength(1);
  });

  it('create_file refuses a Google-native type it does not make, however the type is cased', async () => {
    const { tools, sent } = fakeGoogle();
    const result = await tools.createFile(
      { name: 'Deck', parentId: 'folder', mimeType: 'Application/Vnd.Google-Apps.Presentation', content: 'x' },
      {} as never,
      turn(),
    );
    expect(result.isError).toBe(true);
    body(result);
    expect(sent.filter(({ method }) => method === 'POST')).toEqual([]);
  });

  it('Google not answering comes back as text, not as a thrown error', async () => {
    const { tools } = fakeGoogle({ unreachable: true });
    const result = await tools.readDoc({ documentId: 'spec' }, {} as never, turn());
    expect(result.isError).toBe(true);
    expect(body(result)).toContain('network failure');
  });

  it.each([
    ['Markdown', '# Contract\n', 'text/markdown'],
    ['HTML', '<html><body><h1>Contract</h1></body></html>', 'text/html'],
  ])('create_file asks Google to convert %s into a Google Doc', async (_case, content, mediaType) => {
    const { tools, sent } = fakeGoogle();

    await tools.createFile({ name: 'Contract', parentId: 'folder', mimeType: DOC_TYPE, content }, {} as never, turn());

    const upload = sent.find(({ url }) => url.pathname === '/upload/drive/v3/files')!;
    expect(upload.url.searchParams.get('uploadType')).toBe('multipart');
    expect(upload.body).toContain(`"mimeType":"${DOC_TYPE}"`);
    expect(upload.body).toContain(`Content-Type: ${mediaType}`);
  });

  it('create_file refuses content over 1 MiB', async () => {
    const { tools, sent } = fakeGoogle();
    await expect(
      tools.createFile(
        { name: 'big.txt', parentId: 'folder', mimeType: 'text/plain', content: 'x'.repeat(1024 * 1024 + 1) },
        {} as never,
        turn(),
      ),
    ).rejects.toThrow(/1 MiB/);
    expect(sent).toEqual([]);
  });

  it('a Google error comes back as text with its status', async () => {
    const { tools } = fakeGoogle();
    const result = await tools.readDoc({ documentId: 'locked' }, {} as never, turn());
    expect(result.isError).toBe(true);
    expect(body(result)).toContain('403');
  });

  it('sheet writes store values as given, never as formulas', async () => {
    const { tools, sent } = fakeGoogle();
    const values = [['=IMPORTXML("https://example.com","//a")', 2]];

    await tools.appendValues({ spreadsheetId: 'sheet', range: 'Decisions!A1', values }, {} as never, turn());
    await tools.updateValues({ spreadsheetId: 'sheet', range: 'Decisions!A2:B2', values }, {} as never, turn());

    const [append, update] = sent.filter(({ url }) => url.pathname.startsWith('/v4/spreadsheets/sheet/values/'));
    expect(`${append!.method} ${decodeURIComponent(append!.url.pathname)}`).toBe(
      'POST /v4/spreadsheets/sheet/values/Decisions!A1:append',
    );
    expect(`${update!.method} ${decodeURIComponent(update!.url.pathname)}`).toBe(
      'PUT /v4/spreadsheets/sheet/values/Decisions!A2:B2',
    );
    for (const write of [append!, update!]) {
      expect(write.url.searchParams.get('valueInputOption')).toBe('RAW');
      expect(JSON.parse(write.body!)).toEqual({ values });
    }
  });
});
