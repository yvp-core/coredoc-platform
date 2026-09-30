/**
 * Remote Parser Operations
 *
 * Push/pull parser artifacts to/from the Coredoc cloud workspace.
 * Parsers are transferred as tar.gz archives containing parser.ts and metadata.json.
 */

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'node:crypto';
import { getToken, getServerUrl } from './auth.js';

// =============================================================================
// Types
// =============================================================================

export interface ParserPushOptions {
  workspaceId: string;
  repoName: string;
  parserDir: string;
}

export interface ParserPullOptions {
  workspaceId: string;
  repoName: string;
  targetDir: string;
}

export interface ParserMetaResponse {
  repoName: string;
  version: string;
  sizeBytes: number;
  uploadedBy: string;
  uploadedAt: string;
}

export interface RemoteParserInfo {
  repoName: string;
  sha256: string;
  sizeBytes: number;
  uploadedBy: string;
  uploadedAt: string;
}

// =============================================================================
// Tar helpers (minimal, no external dependencies)
// =============================================================================

/**
 * Create a tar.gz archive from a list of files.
 * Uses a minimal tar implementation to avoid extra dependencies.
 */
export async function createParserArchive(baseDir: string, files: string[]): Promise<Buffer> {
  const tarChunks: Buffer[] = [];

  for (const file of files) {
    const filePath = path.join(baseDir, file);
    if (!fs.existsSync(filePath)) continue;

    const content = fs.readFileSync(filePath);
    const header = createTarHeader(file, content.length);
    tarChunks.push(header);
    tarChunks.push(content);

    // Tar pads each file to 512-byte boundary
    const padding = 512 - (content.length % 512);
    if (padding < 512) {
      tarChunks.push(Buffer.alloc(padding, 0));
    }
  }

  // End-of-archive marker (two 512-byte blocks of zeros)
  tarChunks.push(Buffer.alloc(1024, 0));

  const tarBuffer = Buffer.concat(tarChunks);
  const { gzipSync } = await import('node:zlib');
  return normalizeGzipHeader(gzipSync(tarBuffer));
}

function normalizeGzipHeader(buffer: Buffer): Buffer {
  // Gzip fixed header:
  // 0-1 ID1/ID2, 2 compression method, 3 flags, 4-7 mtime, 8 extra flags, 9 OS.
  if (buffer.length >= 10 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
    buffer.writeUInt32LE(0, 4); // zero mtime for deterministic output
    buffer[8] = 0; // normalize XFL
    buffer[9] = 255; // normalize OS to "unknown"
  }
  return buffer;
}

/**
 * Create a tar header block for a file.
 */
function createTarHeader(fileName: string, size: number): Buffer {
  const header = Buffer.alloc(512, 0);

  // File name (100 bytes)
  header.write(fileName, 0, Math.min(fileName.length, 100), 'utf-8');

  // File mode (8 bytes) - 0644
  header.write('0000644\0', 100, 8, 'utf-8');

  // Owner/group IDs (16 bytes)
  header.write('0001000\0', 108, 8, 'utf-8');
  header.write('0001000\0', 116, 8, 'utf-8');

  // File size in octal (12 bytes)
  header.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'utf-8');

  // Modification time (12 bytes)
  header.write('00000000000\0', 136, 12, 'utf-8');

  // Type flag (1 byte) - '0' = regular file
  header.write('0', 156, 1, 'utf-8');

  // USTAR magic
  header.write('ustar\0', 257, 6, 'utf-8');
  header.write('00', 263, 2, 'utf-8');

  // Compute checksum (8 bytes at offset 148, initially spaces)
  header.write('        ', 148, 8, 'utf-8');
  let checksum = 0;
  for (let i = 0; i < 512; i++) {
    checksum += header[i];
  }
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'utf-8');

  return header;
}

/**
 * Extract a tar.gz archive to a directory.
 */
async function extractTarGz(data: Buffer, targetDir: string): Promise<void> {
  const { createGunzip } = await import('node:zlib');
  const { Readable, Writable } = await import('node:stream');
  const { pipeline } = await import('node:stream/promises');

  const gunzipped: Buffer[] = [];
  const gunzip = createGunzip();
  const input = new Readable({
    read() {
      this.push(data);
      this.push(null);
    },
  });
  const collector = new Writable({
    write(chunk, _encoding, cb) {
      gunzipped.push(chunk);
      cb();
    },
  });

  await pipeline(input, gunzip, collector);
  const tarData = Buffer.concat(gunzipped);

  fs.mkdirSync(targetDir, { recursive: true });

  // Parse tar entries
  let offset = 0;
  while (offset + 512 <= tarData.length) {
    const header = tarData.subarray(offset, offset + 512);

    // Check for end-of-archive (zero block)
    if (header.every((b) => b === 0)) break;

    // Parse file name (first 100 bytes, null-terminated)
    const nameEnd = header.indexOf(0, 0);
    const name = header.subarray(0, Math.min(nameEnd, 100)).toString('utf-8');

    // Parse size (octal string at offset 124, 12 bytes)
    const sizeStr = header.subarray(124, 136).toString('utf-8').trim().replace(/\0/g, '');
    const size = parseInt(sizeStr, 8) || 0;

    offset += 512; // Move past header

    if (name && size > 0) {
      const content = tarData.subarray(offset, offset + size);
      const filePath = path.resolve(targetDir, name);
      const resolvedTarget = path.resolve(targetDir) + path.sep;
      if (!filePath.startsWith(resolvedTarget) && filePath !== resolvedTarget.slice(0, -1)) {
        throw new Error(`Tar entry "${name}" escapes target directory — possible path traversal`);
      }
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content);
    }

    // Advance past file content + padding
    offset += Math.ceil(size / 512) * 512;
  }
}

// =============================================================================
// Auth helpers
// =============================================================================

async function getAuthHeaders(): Promise<Record<string, string>> {
  const token = await getToken();
  if (!token) {
    throw new Error('Not authenticated. Run: coredoc login (or set COREDOC_TOKEN env var)');
  }
  return { Authorization: `Bearer ${token}` };
}

// =============================================================================
// Push parser to server
// =============================================================================

/**
 * Upload a local parser directory to the cloud workspace.
 * Creates a tar.gz of the parser artifact (profile.ts and/or legacy parser.ts,
 * plus optional metadata.json / parser.test.ts sidecars) and uploads it.
 */
export async function pushParserToServer(
  options: ParserPushOptions & { serverUrl?: string; authToken?: string },
): Promise<'uploaded' | 'up-to-date'> {
  const { workspaceId, repoName, parserDir } = options;

  // Validate the local artifact exists. Mirror loadParser precedence: the
  // declarative profile.ts is the canonical artifact and is preferred over a
  // legacy ts-morph parser.ts. Archive whichever is present.
  const hasProfile = fs.existsSync(path.join(parserDir, 'profile.ts'));
  const hasLegacyParser = fs.existsSync(path.join(parserDir, 'parser.ts'));
  if (!hasProfile && !hasLegacyParser) {
    throw new Error(
      `No parser artifact found in ${parserDir} (expected profile.ts or parser.ts). ` +
        `Author one with the author-profile skill first.`,
    );
  }

  // Collect files to archive (profile.ts and/or legacy parser.ts, plus optional sidecars).
  const files: string[] = [];
  if (hasProfile) files.push('profile.ts');
  if (hasLegacyParser) files.push('parser.ts');
  if (fs.existsSync(path.join(parserDir, 'metadata.json'))) {
    files.push('metadata.json');
  }
  if (fs.existsSync(path.join(parserDir, 'parser.test.ts'))) {
    files.push('parser.test.ts');
  }

  // Check remote version before uploading
  const serverUrl = options.serverUrl ?? (await getServerUrl());
  const authHeaders = options.authToken ? { Authorization: `Bearer ${options.authToken}` } : await getAuthHeaders();

  const metaUrl = `${serverUrl}/api/v1/workspaces/${workspaceId}/parsers/${repoName}/meta`;
  const metaRes = await fetch(metaUrl, { headers: authHeaders });
  if (metaRes.ok) {
    const remoteMeta = (await metaRes.json()) as { version?: string };
    if (remoteMeta.version) {
      // Create tar.gz and compare hash with remote version
      const tarGz = await createParserArchive(parserDir, files);
      const fullHash = createHash('sha256').update(tarGz).digest('hex').slice(0, 16);

      if (fullHash === remoteMeta.version) {
        console.log(`Parser for "${repoName}" is already up to date (v${fullHash}).`);
        return 'up-to-date';
      }

      // Upload the already-created tarball
      console.log(`Uploading parser for "${repoName}" (${tarGz.length} bytes)...`);
      const uploadUrl = `${serverUrl}/api/v1/workspaces/${workspaceId}/parsers/${repoName}`;
      const uploadRes = await fetch(uploadUrl, {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/octet-stream' },
        body: tarGz,
      });

      if (!uploadRes.ok) {
        throw new Error(`Upload failed (${uploadRes.status}): ${await uploadRes.text()}`);
      }

      const result = await uploadRes.json();
      console.log(`Parser uploaded successfully: v${(result as { version: string }).version}`);
      return 'uploaded';
    }
  }

  // No remote version — upload fresh
  console.log(`Creating archive for "${repoName}" parser...`);
  const tarGz = await createParserArchive(parserDir, files);

  console.log(`Uploading parser for "${repoName}" (${tarGz.length} bytes)...`);
  const uploadUrl = `${serverUrl}/api/v1/workspaces/${workspaceId}/parsers/${repoName}`;
  const uploadRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/octet-stream' },
    body: tarGz,
  });

  if (!uploadRes.ok) {
    throw new Error(`Upload failed (${uploadRes.status}): ${await uploadRes.text()}`);
  }

  const result = await uploadRes.json();
  console.log(`Parser uploaded successfully: v${(result as { version: string }).version}`);
  return 'uploaded';
}

// =============================================================================
// Pull parser from server
// =============================================================================

/**
 * Download a parser from the cloud workspace and extract to a local directory.
 */
export async function pullParserFromServer(options: ParserPullOptions): Promise<{ version: string }> {
  const { workspaceId, repoName, targetDir } = options;

  const serverUrl = await getServerUrl();
  const authHeaders = await getAuthHeaders();

  console.log(`Fetching parser for "${repoName}"...`);

  const url = `${serverUrl}/api/v1/workspaces/${workspaceId}/parsers/${repoName}`;
  const res = await fetch(url, { headers: authHeaders });

  if (!res.ok) {
    if (res.status === 404) {
      throw new Error(
        `No parser found for repo "${repoName}" in workspace. Upload one first: coredoc parser push -r ${repoName}`,
      );
    }
    throw new Error(`Download failed (${res.status}): ${await res.text()}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  const version = createHash('sha256').update(buffer).digest('hex').slice(0, 16);

  // Extract to target directory
  const parserDir = path.join(targetDir, repoName);
  await extractTarGz(buffer, parserDir);

  console.log(`Parser extracted to ${parserDir} (v${version})`);
  return { version };
}

// =============================================================================
// List remote parsers
// =============================================================================

/**
 * List all parsers available in a cloud workspace.
 */
export async function listRemoteParsers(workspaceId: string): Promise<RemoteParserInfo[]> {
  const serverUrl = await getServerUrl();
  const authHeaders = await getAuthHeaders();

  const url = `${serverUrl}/api/v1/workspaces/${workspaceId}/parsers`;
  const res = await fetch(url, { headers: authHeaders });

  if (!res.ok) {
    throw new Error(`Failed to list parsers (${res.status}): ${await res.text()}`);
  }

  return (await res.json()) as RemoteParserInfo[];
}
