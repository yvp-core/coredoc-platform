import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  createReadStream,
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { basename, join, relative } from 'node:path';
import type {
  AgentProvider,
  Arm,
  ArmFactors,
  CaseId,
  GraphBackend,
  JudgeMode,
  PrimaryVerifierId,
  RunnableLifecycle,
} from './types.js';
import type {
  PermissionCanaryConfig,
  PermissionCanaryEvidence,
} from './permission-canary.js';
import { compareCodeUnits } from './deterministic-order.js';

export interface DirtyInput {
  trackedPatch: string | Buffer;
  untracked: ReadonlyArray<{
    path: string;
    content: string | Buffer;
    kind?: 'file' | 'symlink';
  }>;
}

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function frame(hash: ReturnType<typeof createHash>, label: string, value: string | Buffer): void {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  hash.update(Buffer.from(`${label.length}:${label}:${bytes.length}:`));
  hash.update(bytes);
}

export function fingerprintDirtyInput(input: DirtyInput): string {
  const hash = createHash('sha256');
  frame(hash, 'tracked-head-patch', input.trackedPatch);
  for (const item of [...input.untracked].sort((a, b) => compareCodeUnits(a.path, b.path))) {
    frame(hash, 'untracked-path', item.path);
    frame(hash, 'untracked-kind', item.kind ?? 'file');
    frame(hash, 'untracked-content-sha256', sha256(item.content));
  }
  return hash.digest('hex');
}

export function fingerprintWorkingTree(repoPath: string): string {
  const trackedPatch = execFileSync(
    'git',
    [
      '-C',
      repoPath,
      'diff',
      '--binary',
      '--full-index',
      '--no-ext-diff',
      '--no-textconv',
      '--no-renames',
      'HEAD',
      '--',
    ],
    { encoding: 'buffer', maxBuffer: 1024 * 1024 * 1024 },
  );
  const paths = execFileSync(
    'git',
    ['-C', repoPath, 'ls-files', '--others', '--exclude-standard', '-z'],
    { encoding: 'buffer', maxBuffer: 1024 * 1024 * 1024 },
  )
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .sort();
  const untracked = paths.map((path) => {
    const absolute = join(repoPath, path);
    const isSymlink = lstatSync(absolute).isSymbolicLink();
    const content = isSymlink
      ? Buffer.from(readlinkSync(absolute))
      : readFileSync(absolute);
    return { path, content, kind: isSymlink ? ('symlink' as const) : ('file' as const) };
  });
  return fingerprintDirtyInput({ trackedPatch, untracked });
}

export function gitHead(repoPath: string): string {
  return execFileSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

export interface GraphComponent {
  identity: string;
  size: number;
}

export interface GraphFingerprint {
  fingerprint: string;
  components: GraphComponent[];
}

function filesBelow(root: string): Array<{ absolute: string; identity: string }> {
  const stat = statSync(root);
  if (stat.isFile()) return [{ absolute: root, identity: basename(root) }];
  if (!stat.isDirectory()) throw new Error(`Graph backend path is neither a file nor directory: ${root}`);
  const result: Array<{ absolute: string; identity: string }> = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => compareCodeUnits(a.name, b.name))) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) result.push({ absolute, identity: relative(root, absolute) });
      else if (entry.isSymbolicLink()) {
        throw new Error(`Graph backend contains unsupported symbolic link: ${absolute}`);
      }
    }
  };
  visit(root);
  return result.sort((a, b) => compareCodeUnits(a.identity, b.identity));
}

async function updateFromFile(hash: ReturnType<typeof createHash>, path: string): Promise<void> {
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
}

export async function fingerprintGraphBackend(
  backend: GraphBackend,
  backendPath: string,
): Promise<GraphFingerprint> {
  if (!existsSync(backendPath)) throw new Error(`Graph backend path does not exist: ${backendPath}`);
  const files =
    backend === 'sqlite'
      ? [backendPath, `${backendPath}-wal`]
          .filter(existsSync)
          .map((absolute) => ({ absolute, identity: basename(absolute) }))
      : filesBelow(backendPath);
  if (files.length === 0) throw new Error(`Graph backend has no files to fingerprint: ${backendPath}`);
  const hash = createHash('sha256');
  const components: GraphComponent[] = [];
  for (const file of files.sort((a, b) => compareCodeUnits(a.identity, b.identity))) {
    const size = statSync(file.absolute).size;
    frame(hash, 'component', file.identity);
    frame(hash, 'size', String(size));
    await updateFromFile(hash, file.absolute);
    components.push({ identity: file.identity, size });
  }
  return { fingerprint: hash.digest('hex'), components };
}

export async function fingerprintPath(path: string | null): Promise<string | null> {
  if (!path || !existsSync(path)) return null;
  const files = filesBelow(path);
  const hash = createHash('sha256');
  for (const file of files) {
    frame(hash, 'path', file.identity);
    await updateFromFile(hash, file.absolute);
  }
  return hash.digest('hex');
}

/** Canonical hash of a logical source bundle; absolute host paths are not inputs. */
export async function fingerprintNamedPaths(
  paths: Readonly<Record<string, string | null>>,
): Promise<string | null> {
  const hash = createHash('sha256');
  for (const [identity, path] of Object.entries(paths).sort(([a], [b]) => compareCodeUnits(a, b))) {
    const fingerprint = await fingerprintPath(path);
    if (fingerprint === null) return null;
    frame(hash, 'component-name', identity);
    frame(hash, 'component-sha256', fingerprint);
  }
  return hash.digest('hex');
}

export interface RunManifestInput {
  createdAt: string;
  harness: { head: string; dirtyFingerprint: string };
  targets: ReadonlyArray<{
    manifestPath: string;
    manifestHash: string;
    repoKey: string;
    requestedGitSha: string;
    actualVerifierGitSha: string;
    actualAgentGitSha: string | null;
  }>;
  graph: {
    backend: GraphBackend;
    path: string;
    fingerprint: string;
    /** Whether the MCP server exposed includeSource/source bodies this run. */
    sourceInGraph?: boolean;
    repositories: ReadonlyArray<{
      repoKey: string;
      parsedGitSha: string;
      parsedAt: string | null;
      parserVersion: string | null;
    }>;
  };
  cells: ReadonlyArray<{
    target: string;
    case: CaseId;
    lifecycle: RunnableLifecycle;
    primaryVerifierId: PrimaryVerifierId | null;
    promptHash: string;
    oracleHash: string | null;
    caseHash: string | null;
    verifierHash: string | null;
    repoRevisions: Readonly<Record<string, {
      requestedGitSha: string;
      graphGitSha: string;
      localObjectSha: string | null;
      checkoutHeadSha: string | null;
      checkoutTrackedClean: boolean | null;
    }>>;
  }>;
  arms: ReadonlyArray<{
    arm: Arm;
    factors: ArmFactors;
    systemPromptHash: string;
    skillHash: string | null;
  }>;
  mcp: {
    mcpSchemaHash: string | null;
    mcpBuildHash: string | null;
  };
  models: {
    provider: AgentProvider;
    agentModel: string;
    agentSdkVersion: string | null;
    judgeProvider: string;
    judgeModel: string;
    judgeSdkVersion: string | null;
    judgeMode: JudgeMode;
  };
  permissionCanary: {
    config: PermissionCanaryConfig | null;
    evidence: PermissionCanaryEvidence | null;
  };
}

export interface RunManifest extends RunManifestInput {
  schemaVersion: 1;
  cohortId: string;
  oracleJudgeUsage: { calls: number; totalTokens: number; costUsd: number } | null;
  graphFingerprintAfter: string | null;
  graphChangedDuringRun: boolean | null;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => compareCodeUnits(a, b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function createRunManifest(input: RunManifestInput): RunManifest {
  const cohortBasis = {
    schemaVersion: 1,
    harness: input.harness,
    targets: input.targets,
    graph: input.graph,
    cells: input.cells,
    arms: input.arms,
    mcp: input.mcp,
    models: input.models,
    permissionCanaryConfig: input.permissionCanary.config,
  };
  return {
    schemaVersion: 1,
    ...input,
    cohortId: sha256(canonical(cohortBasis)),
    oracleJudgeUsage: null,
    graphFingerprintAfter: null,
    graphChangedDuringRun: null,
  };
}

export function recordPermissionCanaryEvidence(
  manifest: RunManifest,
  evidence: PermissionCanaryEvidence,
): void {
  const config = manifest.permissionCanary.config;
  if (!config) {
    throw new Error('Run manifest has no permission canary configuration.');
  }
  if (evidence.materialFingerprint !== config.materialFingerprint) {
    throw new Error('Permission canary evidence material fingerprint does not match the run.');
  }
  if (
    evidence.contractVersion !== config.contractVersion ||
    evidence.contractHash !== config.queryPolicyHash ||
    evidence.model !== config.model
  ) {
    throw new Error('Permission canary evidence does not match the configured contract/model.');
  }
  manifest.permissionCanary.evidence = evidence;
}
