// Docs, Drive and Sheets over plain HTTPS as one service account (house pattern: native
// fetch, as jira-client.ts and github-client.ts). Every content call takes a `DriveFile`,
// which only `file()` hands out after checking the file is in the configured shared drive.

import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { JWT } from 'google-auth-library';
import {
  type AgentGoogleConfig,
  CONNECTORS_CONFIG,
  type ConnectorsConfig,
  configFromEnv,
} from '../../config/app-config.js';
import { asRecord } from '../coerce.js';

const TIMEOUT_MS = 30_000;
// The Docs and Sheets APIs accept the Drive scope; `drive.file` would not reach documents a person created.
const SCOPES = ['https://www.googleapis.com/auth/drive'];
const DRIVE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const DOCS = 'https://docs.googleapis.com/v1';
const SHEETS = 'https://sheets.googleapis.com/v4';

export const GOOGLE_DOC = 'application/vnd.google-apps.document';
export const GOOGLE_FOLDER = 'application/vnd.google-apps.folder';
const GOOGLE_NATIVE_PREFIX = 'application/vnd.google-apps.';

/** Drive keeps app properties per calling application: only this service account's project reads the mark. */
const AGENT_MARK = { coredocAgentRun: 'true' };
const FILE_FIELDS = 'id,name,mimeType,parents,modifiedTime,size,driveId,appProperties';
/** What one read may return: a session cannot use more, and the server holds it in memory. */
const MAX_READ_BYTES = 2 * 1024 * 1024;
const TEXT_TYPE = /^(text\/.+|application\/(json|csv))$/;
const COMMENT_FIELDS =
  'nextPageToken,comments(id,content,resolved,createdTime,modifiedTime,author(displayName),quotedFileContent(value),' +
  'replies(id,content,action,createdTime,author(displayName)))';
const MAX_COMMENT_PAGES = 10;
const MAX_ERROR_CHARS = 500;

export interface GoogleRequest {
  method: string;
  headers: Record<string, string>;
  body?: string;
}
/** The authorised HTTP call to Google; tests replace it to stand in for Google. */
export type GoogleFetch = (url: string, init: GoogleRequest) => Promise<Response>;
export const AGENT_GOOGLE_FETCH = 'AGENT_GOOGLE_FETCH';

/** A failure the calling agent is told about as text, never a server error. */
export class AgentGoogleError extends Error {}

/** A non-2xx answer from Google, or a token the service account could not get. */
export class GoogleApiError extends AgentGoogleError {
  constructor(
    readonly status: number,
    detail: string,
  ) {
    super(`Google API ${status}: ${detail}`);
  }
}

/** A call this server refuses without asking Google to do it. */
export class GoogleRefusal extends AgentGoogleError {}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  modifiedTime: string | null;
  /** Bytes of a stored file; null for a Google-native one. */
  size: number | null;
  /** Created by `createFile`, so an agent run may trash it. */
  agentCreated: boolean;
}

/** The configuration when it names this workspace; null for every other workspace and when unset. */
export function agentGoogleFor(connectors: ConnectorsConfig, workspaceId: string): AgentGoogleConfig | null {
  return connectors.agentGoogle?.workspaceId === workspaceId ? connectors.agentGoogle : null;
}

function serviceAccountFetch(config: AgentGoogleConfig): GoogleFetch {
  const jwt = new JWT({
    email: config.serviceAccount.clientEmail,
    key: config.serviceAccount.privateKey,
    scopes: SCOPES,
  });
  return async (url, init) => {
    let token: string | null | undefined;
    try {
      ({ token } = await jwt.getAccessToken());
    } catch (error) {
      // The library's message can quote the token request; the status is enough.
      const status = (error as { response?: { status?: unknown } }).response?.status;
      throw new GoogleApiError(
        typeof status === 'number' ? status : 401,
        'the service account could not get an access token',
      );
    }
    if (!token) throw new GoogleApiError(401, 'the service account could not get an access token');
    return fetch(url, {
      ...init,
      headers: { ...init.headers, Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  };
}

function driveString(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function toFile(raw: Record<string, unknown>): DriveFile {
  return {
    id: String(raw.id),
    name: String(raw.name ?? ''),
    mimeType: String(raw.mimeType ?? ''),
    parents: Array.isArray(raw.parents) ? raw.parents.map(String) : [],
    modifiedTime: typeof raw.modifiedTime === 'string' ? raw.modifiedTime : null,
    // Drive sends int64 fields as strings.
    size: raw.size === undefined || raw.size === null ? null : Number(raw.size),
    agentCreated: asRecord(raw.appProperties).coredocAgentRun === AGENT_MARK.coredocAgentRun,
  };
}

function query(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

@Injectable()
export class AgentGoogle {
  private readonly config: AgentGoogleConfig | undefined;
  private readonly fetch: GoogleFetch | undefined;

  constructor(
    @Optional() @Inject(CONNECTORS_CONFIG) readonly connectors: ConnectorsConfig = configFromEnv().connectors,
    @Optional() @Inject(AGENT_GOOGLE_FETCH) fetcher?: GoogleFetch,
  ) {
    this.config = connectors.agentGoogle;
    this.fetch = fetcher ?? (this.config ? serviceAccountFetch(this.config) : undefined);
  }

  /** The file's metadata, after refusing one outside the configured shared drive. */
  async file(id: string): Promise<DriveFile> {
    const raw = asRecord(
      await this.json(
        'GET',
        `${DRIVE}/files/${encodeURIComponent(id)}?${query({ supportsAllDrives: 'true', fields: FILE_FIELDS })}`,
      ),
    );
    const drive = this.sharedDriveId();
    if (raw.driveId !== drive && raw.id !== drive) {
      throw new GoogleRefusal(`${id} is outside the shared drive agent runs are confined to`);
    }
    return toFile(raw);
  }

  /** Accepted text and pending suggestions together: the only view whose indexes a later update can use. */
  document(file: DriveFile): Promise<unknown> {
    return this.json(
      'GET',
      `${DOCS}/documents/${encodeURIComponent(file.id)}?${query({ suggestionsViewMode: 'SUGGESTIONS_INLINE', includeTabsContent: 'true' })}`,
    );
  }

  async suggest(file: DriveFile, requests: unknown[], requiredRevisionId: string): Promise<Record<string, unknown>> {
    return asRecord(
      await this.json('POST', `${DOCS}/documents/${encodeURIComponent(file.id)}:batchUpdate`, {
        requests,
        writeControl: { requiredRevisionId, writeMode: 'SUGGEST' },
      }),
    );
  }

  async comments(file: DriveFile): Promise<{ comments: unknown[]; complete: boolean }> {
    const comments: unknown[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_COMMENT_PAGES; page++) {
      const res = asRecord(
        await this.json(
          'GET',
          `${DRIVE}/files/${encodeURIComponent(file.id)}/comments?${query({
            fields: COMMENT_FIELDS,
            pageSize: '100',
            ...(pageToken ? { pageToken } : {}),
          })}`,
        ),
      );
      if (Array.isArray(res.comments)) comments.push(...res.comments);
      pageToken = typeof res.nextPageToken === 'string' && res.nextPageToken ? res.nextPageToken : undefined;
      if (!pageToken) return { comments, complete: true };
    }
    return { comments, complete: false };
  }

  /** One page of the shared drive's files, not trashed; `complete` is false when more match. */
  async search(
    name: string | undefined,
    parent: DriveFile | undefined,
  ): Promise<{ files: unknown[]; complete: boolean }> {
    const clauses = [
      'trashed = false',
      ...(name ? [`name contains ${driveString(name)}`] : []),
      ...(parent ? [`${driveString(parent.id)} in parents`] : []),
    ];
    const res = asRecord(
      await this.json(
        'GET',
        `${DRIVE}/files?${query({
          corpora: 'drive',
          driveId: this.sharedDriveId(),
          includeItemsFromAllDrives: 'true',
          supportsAllDrives: 'true',
          q: clauses.join(' and '),
          pageSize: '100',
          fields: 'nextPageToken,files(id,name,mimeType,parents,modifiedTime)',
        })}`,
      ),
    );
    return { files: Array.isArray(res.files) ? res.files : [], complete: !res.nextPageToken };
  }

  /** A Google Doc as Markdown, a stored text file of at most 2 MiB as it is; anything else is refused unread. */
  async text(file: DriveFile): Promise<string> {
    const id = encodeURIComponent(file.id);
    if (file.mimeType === GOOGLE_DOC) {
      const markdown = await (
        await this.call('GET', `${DRIVE}/files/${id}/export?${query({ mimeType: 'text/markdown' })}`)
      ).text();
      if (Buffer.byteLength(markdown) > MAX_READ_BYTES) {
        throw new GoogleRefusal(`${file.id} is over 2 MiB as Markdown; read it with read_doc`);
      }
      return markdown;
    }
    const supported = 'read_file_content reads Google Docs and stored text files (text/*, JSON, CSV) of at most 2 MiB';
    if (!TEXT_TYPE.test(file.mimeType.toLowerCase())) {
      throw new GoogleRefusal(`${file.id} is a ${file.mimeType}: ${supported}`);
    }
    if (file.size === null || !(file.size <= MAX_READ_BYTES)) {
      throw new GoogleRefusal(`${file.id} is ${file.size ?? 'an unknown number of'} bytes: ${supported}`);
    }
    return (
      await this.call('GET', `${DRIVE}/files/${id}?${query({ alt: 'media', supportsAllDrives: 'true' })}`)
    ).text();
  }

  /** `content` becomes a Google Doc's first text (Markdown or HTML), or the stored file's bytes; a folder has none. */
  async createFile(parent: DriveFile, name: string, mimeType: string, content: string): Promise<DriveFile> {
    const metadata = { name, mimeType, parents: [parent.id], appProperties: AGENT_MARK };
    const params = query({ supportsAllDrives: 'true', fields: FILE_FIELDS });
    if (mimeType === GOOGLE_FOLDER)
      return toFile(asRecord(await this.json('POST', `${DRIVE}/files?${params}`, metadata)));
    if (mimeType.startsWith(GOOGLE_NATIVE_PREFIX) && mimeType !== GOOGLE_DOC) {
      throw new GoogleRefusal(`create_file makes Google Docs, folders and plain files, not ${mimeType}`);
    }
    const mediaType =
      mimeType !== GOOGLE_DOC ? mimeType : /^\s*<(!doctype|html)\b/i.test(content) ? 'text/html' : 'text/markdown';
    const boundary = `coredoc-${randomUUID()}`;
    const body = [
      `--${boundary}`,
      'Content-Type: application/json; charset=UTF-8',
      '',
      JSON.stringify(metadata),
      `--${boundary}`,
      `Content-Type: ${mediaType}; charset=UTF-8`,
      '',
      content,
      `--${boundary}--`,
      '',
    ].join('\r\n');
    const res = await this.call('POST', `${DRIVE_UPLOAD}/files?${query({ uploadType: 'multipart' })}&${params}`, {
      body,
      contentType: `multipart/related; boundary=${boundary}`,
    });
    return toFile(asRecord(await res.json()));
  }

  async trash(file: DriveFile): Promise<void> {
    if (!file.agentCreated) throw new GoogleRefusal(`${file.id} was not created by an agent run, so it is not trashed`);
    if (file.mimeType === GOOGLE_FOLDER) {
      throw new GoogleRefusal(`${file.id} is a folder: trashing it would trash every file in it, so it is not trashed`);
    }
    await this.json(
      'PATCH',
      `${DRIVE}/files/${encodeURIComponent(file.id)}?${query({ supportsAllDrives: 'true', fields: 'id' })}`,
      {
        trashed: true,
      },
    );
  }

  spreadsheet(file: DriveFile): Promise<unknown> {
    return this.json(
      'GET',
      `${SHEETS}/spreadsheets/${encodeURIComponent(file.id)}?${query({
        fields:
          'spreadsheetId,properties(title),sheets(properties(sheetId,title,index,gridProperties(rowCount,columnCount)))',
      })}`,
    );
  }

  /** The size is known only once Google has answered, so an over-large range is refused after the call. */
  async values(file: DriveFile, range: string): Promise<unknown> {
    const text = await (await this.call('GET', this.valuesUrl(file, range))).text();
    if (Buffer.byteLength(text) > MAX_READ_BYTES) {
      throw new GoogleRefusal(`The values of ${range} are over 2 MiB; ask for a narrower range`);
    }
    return JSON.parse(text);
  }

  /** RAW: a value starting with `=` is stored as text, never run as a formula. */
  appendValues(file: DriveFile, range: string, values: unknown[][]): Promise<unknown> {
    return this.json(
      'POST',
      `${this.valuesUrl(file, range)}:append?${query({ valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS' })}`,
      { values },
    );
  }

  updateValues(file: DriveFile, range: string, values: unknown[][]): Promise<unknown> {
    return this.json('PUT', `${this.valuesUrl(file, range)}?${query({ valueInputOption: 'RAW' })}`, { values });
  }

  private valuesUrl(file: DriveFile, range: string): string {
    return `${SHEETS}/spreadsheets/${encodeURIComponent(file.id)}/values/${encodeURIComponent(range)}`;
  }

  private sharedDriveId(): string {
    if (!this.config) throw new GoogleRefusal('Google is not configured on this server');
    return this.config.sharedDriveId;
  }

  private async json(method: string, url: string, body?: unknown): Promise<unknown> {
    const res = await this.call(
      method,
      url,
      body === undefined ? undefined : { body: JSON.stringify(body), contentType: 'application/json' },
    );
    return res.status === 204 ? undefined : res.json();
  }

  private async call(method: string, url: string, send?: { body: string; contentType: string }): Promise<Response> {
    if (!this.fetch) throw new GoogleRefusal('Google is not configured on this server');
    let res: Response;
    try {
      res = await this.fetch(url, {
        method,
        headers: { Accept: 'application/json', ...(send ? { 'Content-Type': send.contentType } : {}) },
        body: send?.body,
      });
    } catch (error) {
      if (error instanceof AgentGoogleError) throw error;
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      throw new AgentGoogleError(
        `Google did not answer (${timedOut ? 'timeout' : 'network failure'}); whether a write took effect is unknown`,
      );
    }
    if (res.ok) return res;
    const text = await res.text();
    let detail = text;
    try {
      const error = asRecord(asRecord(JSON.parse(text)).error);
      if (typeof error.message === 'string') detail = error.message;
    } catch {
      // intentional: not every Google error body is JSON; the raw text is the detail then.
    }
    throw new GoogleApiError(res.status, detail.slice(0, MAX_ERROR_CHARS) || res.statusText);
  }
}
