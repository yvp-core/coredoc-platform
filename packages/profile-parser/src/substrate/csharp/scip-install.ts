import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, sep } from 'node:path';
import { resolveCoredocHome } from '@coredoc/core/utils';
import { SCIP_DOTNET_RELEASE } from './scip-release.js';
import { outsideSource } from './workspace.js';

function destination(repoRoot?: string): string {
  const target = join(resolveCoredocHome(), 'tools', 'scip-dotnet', SCIP_DOTNET_RELEASE.version);
  return repoRoot ? outsideSource(repoRoot, target) : target;
}

function contentsHash(directory: string): string {
  const hash = createHash('sha256');
  const files = readdirSync(directory, { recursive: true, withFileTypes: true })
    .flatMap((entry) => {
      if (entry.isSymbolicLink()) throw new Error('Installed compiler tools must not contain symbolic links.');
      return entry.isFile() ? [relative(directory, join(entry.parentPath, entry.name)).split(sep).join('/')] : [];
    })
    .filter((file) => file !== 'archive.sha256')
    .sort();
  for (const file of files)
    hash
      .update(file)
      .update('\0')
      .update(readFileSync(join(directory, file)))
      .update('\0');
  return hash.digest('hex');
}

export function installedCSharpTool(repoRoot?: string): string | undefined {
  const directory = destination(repoRoot);
  try {
    // Re-check executable bytes, not a self-written marker, before using the installed release.
    if (contentsHash(directory) === SCIP_DOTNET_RELEASE.contentsSha256) return join(directory, 'scip-dotnet.dll');
  } catch {
    // Interrupted or modified installs can be repaired by another explicit install.
  }
  return undefined;
}

/** Explicit user action only. The parser's discovery path never calls this. */
export async function installCSharpTool(
  repoRoot?: string,
  options: {
    signal?: AbortSignal;
    onLog?: (message: string) => void;
    onProgress?: (received: number, total?: number) => void;
  } = {},
): Promise<string> {
  if (process.platform !== 'darwin' && process.platform !== 'linux')
    throw new Error('C# enhanced analysis is currently supported on macOS and Linux. Use basic analysis here.');
  if (existsSync('/etc/alpine-release')) throw new Error('The Alpine CLI image supports C# basic analysis only.');
  options.signal?.throwIfAborted();
  const existing = installedCSharpTool(repoRoot);
  if (existing) return existing;
  const target = destination(repoRoot);
  const parent = join(target, '..');
  mkdirSync(parent, { recursive: true });
  const work = mkdtempSync(join(parent, 'install-'));
  try {
    options.onLog?.(`Downloading scip-dotnet ${SCIP_DOTNET_RELEASE.version} (about 18 MB)…`);
    const signal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(120_000)])
      : AbortSignal.timeout(120_000);
    const response = await fetch(SCIP_DOTNET_RELEASE.url, { signal });
    if (!response.ok || !response.body) throw new Error(`SCIP download failed (HTTP ${response.status}).`);
    const chunks: Uint8Array[] = [];
    let size = 0;
    const total = Number(response.headers.get('content-length')) || undefined;
    let lastUpdate = 0;
    options.onProgress?.(0, total);
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 64 * 1024 * 1024) throw new Error('SCIP download exceeds the expected archive size.');
      chunks.push(chunk);
      if (Date.now() - lastUpdate >= 250) {
        options.onProgress?.(size, total);
        lastUpdate = Date.now();
      }
    }
    options.onProgress?.(size, total);
    const bytes = Buffer.concat(chunks);
    if (createHash('sha256').update(bytes).digest('hex') !== SCIP_DOTNET_RELEASE.sha256)
      throw new Error('SCIP checksum verification failed. No tool was installed; retry the download.');
    options.signal?.throwIfAborted();
    const archive = join(work, 'tool.tar.gz');
    const unpacked = join(work, 'unpacked');
    writeFileSync(archive, bytes);
    mkdirSync(unpacked);
    // Only the fixed, checksum-verified release reaches the system archive tool.
    execFileSync('/usr/bin/tar', ['-xzf', archive, '-C', unpacked], {
      timeout: 30_000,
      stdio: 'pipe',
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
    });
    const manifest = JSON.parse(readFileSync(join(unpacked, 'coredoc-tool.json'), 'utf8'));
    if (
      manifest.version !== SCIP_DOTNET_RELEASE.version ||
      manifest.runtime !== 'net10.0' ||
      manifest.receiverTypes !== 1 ||
      manifest.defines !== true ||
      !existsSync(join(unpacked, 'scip-dotnet.dll')) ||
      !existsSync(join(unpacked, 'scip-dotnet.runtimeconfig.json'))
    )
      throw new Error('SCIP release does not contain the expected compiler tool.');
    if (contentsHash(unpacked) !== SCIP_DOTNET_RELEASE.contentsSha256)
      throw new Error('SCIP extracted contents do not match the pinned release.');
    options.signal?.throwIfAborted();
    if (existsSync(target) && !installedCSharpTool(repoRoot)) rmSync(target, { recursive: true, force: true });
    try {
      renameSync(unpacked, target);
    } catch (error) {
      // Concurrent explicit installs converge on the same verified release.
      if (!installedCSharpTool(repoRoot)) throw error;
    }
    options.onLog?.(`Installed scip-dotnet ${SCIP_DOTNET_RELEASE.version}. .NET SDK 10 is required separately.`);
    return join(target, 'scip-dotnet.dll');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
