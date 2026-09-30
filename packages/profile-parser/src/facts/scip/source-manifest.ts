import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { deserialize, serialize } from 'node:v8';
import { loadScip, type LoadedScip } from './decode.js';

export interface SourceCheckedScip extends LoadedScip {
  sourceHashes: Record<string, string>;
}

const sha256 = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');

interface SourceManifest {
  indexSha256: string;
  sources: Record<string, string>;
  cacheKey?: string;
}

/** A captured generation; consumers must not reopen the replaceable cache path. */
export interface ScipArtifact {
  bytes: Buffer;
  manifest: SourceManifest;
}

export interface OptionalScipResult {
  ok: boolean;
  scip?: ScipArtifact;
  scipPath?: string;
  degradeReason?: string;
}

function publishArtifact(bytes: Buffer, manifest: SourceManifest, targetPath: string): void {
  const temporary = mkdtempSync(join(dirname(targetPath), '.publish-scip-'));
  try {
    if (targetPath.endsWith('.scip-cache')) {
      // One atomic file keeps the last successful index and its evidence together.
      // Failed or concurrent replacements cannot leave mismatched sidecars or history.
      // A private binary cache avoids base64 growth and V8's JSON string-size limit.
      const cachePath = join(temporary, 'latest.scip-cache');
      writeFileSync(cachePath, serialize({ ...manifest, scip: bytes }));
      renameSync(cachePath, targetPath);
      return;
    }
    // Raw SCIP cache targets are keyed by source inputs; Desktop targets belong to one request.
    // Equal index digests at these targets therefore describe the same source manifest.
    const indexPath = join(temporary, 'index.scip');
    const manifestPath = join(temporary, 'sources.json');
    writeFileSync(indexPath, bytes);
    writeFileSync(manifestPath, JSON.stringify(manifest));
    // Publish the immutable manifest first. Replacing the index is the single commit point;
    // readers holding earlier bytes can still find their manifest after a concurrent replacement.
    renameSync(manifestPath, `${targetPath}.${manifest.indexSha256}.sources.json`);
    renameSync(indexPath, targetPath);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

/** Bind compiler evidence to source hashes captured before compilation. */
export function publishOptionalScip(
  indexPath: string,
  targetPath: string,
  snapshot: { root: string; sourceHashes: Record<string, string> },
  cacheKey?: string,
): ScipArtifact {
  for (const [file, hash] of Object.entries(snapshot.sourceHashes)) {
    if (sha256(readFileSync(join(snapshot.root, file))) !== hash)
      throw new Error(`Compiler inputs changed during indexing: ${file}. Re-index the source.`);
  }
  const bytes = readFileSync(indexPath);
  const manifest = { indexSha256: sha256(bytes), sources: snapshot.sourceHashes, cacheKey };
  publishArtifact(bytes, manifest, targetPath);
  return { bytes, manifest };
}

function readArtifact(path: string): ScipArtifact {
  if (path.endsWith('.scip-cache')) {
    const { scip: bytes, ...manifest } = deserialize(readFileSync(path)) as SourceManifest & { scip: Buffer };
    if (!Buffer.isBuffer(bytes) || !manifest.sources || sha256(bytes) !== manifest.indexSha256)
      throw new Error('Compiler index and source manifest do not match. Re-index the source.');
    return { bytes, manifest };
  }
  const bytes = readFileSync(path);
  const digest = sha256(bytes);
  let manifest: SourceManifest;
  try {
    let json: string;
    try {
      json = readFileSync(`${path}.${digest}.sources.json`, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // Existing caches and checked-in fixtures use the original sidecar name.
      json = readFileSync(`${path}.sources.json`, 'utf8');
    }
    manifest = JSON.parse(json);
  } catch {
    throw new Error('Compiler source manifest is missing or unreadable. Re-index the source.');
  }
  if (!manifest?.sources || digest !== manifest.indexSha256)
    throw new Error('Compiler index and source manifest do not match. Re-index the source.');
  return { bytes, manifest };
}

/** An absent, stale or interrupted cache is rebuilt through the normal indexing path. */
export function cachedOptionalScip(path: string, cacheKey: string): ScipArtifact | undefined {
  try {
    const artifact = readArtifact(path);
    const { bytes, manifest } = artifact;
    if (manifest.cacheKey !== cacheKey) return undefined;
    const index = loadScip(path, bytes);
    return !index.lenientUtf8 && index.documents.some((doc) => doc.occurrences.length > 0) ? artifact : undefined;
  } catch {
    return undefined;
  }
}

/** Desktop transfers the exact captured pair even if the shared cache is replaced while reading. */
export function copyOptionalScip(source: string | ScipArtifact, targetPath: string): void {
  const { bytes, manifest } = typeof source === 'string' ? readArtifact(source) : source;
  publishArtifact(bytes, manifest, targetPath);
}

export function loadOptionalScip(source: string | ScipArtifact): SourceCheckedScip {
  const { bytes, manifest } = typeof source === 'string' ? readArtifact(source) : source;
  return { ...loadScip(typeof source === 'string' ? source : 'captured.scip', bytes), sourceHashes: manifest.sources };
}

/** Every file in the analysis target must be covered before any positional evidence is consumed. */
export function assertScipSources(index: SourceCheckedScip, files: { path: string; source: string }[]): void {
  if (index.lenientUtf8) throw new Error('The compiler index contains invalid symbol encoding; re-index it.');
  const documents = new Set(index.documents.map((doc) => doc.relativePath.replace(/^\.\//, '')));
  const missing = files.filter((file) => !documents.has(file.path));
  if (!files.length || missing.length) {
    const examples = missing
      .slice(0, 3)
      .map((file) => file.path)
      .join(', ');
    throw new Error(
      `Compiler index covers ${files.length - missing.length}/${files.length} target files${examples ? `; missing ${examples}` : ''}. Re-index the complete target or use basic analysis.`,
    );
  }
  for (const file of files) {
    if (index.sourceHashes[file.path] !== sha256(file.source))
      throw new Error(`Compiler source differs from parsed source: ${file.path}. Re-parse and re-index the source.`);
  }
}
