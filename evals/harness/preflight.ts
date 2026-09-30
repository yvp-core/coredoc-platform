import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getEvalRepository, repoHashFor } from './verifier.js';
import type { LoadedTarget, SelectedCell } from './target-loader.js';
import { AccessMode } from './types.js';
import {
  assertRegisteredPrimary,
  type PrimaryRegistration,
} from './primary-registry.js';

const run = promisify(execFile);

const FILE_TRUTH_KEYS = new Set([
  'expectedTouchedFiles',
  'expectedReachableFiles',
  'expectedFiles',
  'expectedImpactedFiles',
]);

function endpointKey(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const endpoint = value as Record<string, unknown>;
  if (typeof endpoint.method !== 'string' || typeof endpoint.path !== 'string') return null;
  const normalizedPath = endpoint.path === '/' ? '/' : endpoint.path.replace(/\/+$/, '');
  return `${endpoint.method.toUpperCase()} ${normalizedPath}`;
}

export function assertCellTruth(opts: {
  selected: SelectedCell;
  prompt: string;
  targetRepoKey?: string;
  pathExists?: (repoKey: string, path: string) => boolean;
}): void {
  const { selected } = opts;
  const params = selected.cell.params;
  const truthArrays = Object.entries(params).filter(
    ([key, value]) => key.startsWith('expected') && Array.isArray(value),
  ) as Array<[string, unknown[]]>;
  if (selected.cell.lifecycle === 'primary') {
    if (!selected.cell.admission) {
      throw new Error(`${selected.caseId}: primary cells require an admission artifact.`);
    }
    if (!selected.cell.truth || selected.cell.truth.required.length === 0) {
      throw new Error(`${selected.caseId}: primary structured truth requires non-empty required facts.`);
    }
  }

  if (
    params.truthScope === 'bounded' &&
    /\b(?:every|complete|all)\b/i.test(opts.prompt)
  ) {
    throw new Error(
      `${selected.caseId}: bounded truth cannot score an EVERY/COMPLETE/ALL task claim.`,
    );
  }

  if (selected.caseId === 'transitive-callers-closure') {
    const root = params.symbol;
    const closure = params.expectedClosure;
    if (
      typeof root === 'string' &&
      Array.isArray(closure) &&
      closure.some((item) => typeof item === 'string' && item.toLowerCase() === root.toLowerCase())
    ) {
      throw new Error(`${selected.caseId}: closure root "${root}" must be excluded from expectedClosure.`);
    }
  }

  const endpoints = params.expectedEndpoints;
  if (Array.isArray(endpoints)) {
    const seen = new Set<string>();
    for (const endpoint of endpoints) {
      const key = endpointKey(endpoint);
      if (!key) throw new Error(`${selected.caseId}: expectedEndpoints must contain method/path objects.`);
      if (seen.has(key)) throw new Error(`${selected.caseId}: duplicate endpoint ${key}.`);
      seen.add(key);
    }
  }

  if (!opts.pathExists) return;
  const structuredFacts = selected.cell.truth
    ? [
        ...selected.cell.truth.required,
        ...selected.cell.truth.accepted,
        ...selected.cell.truth.forbidden,
      ]
    : [];
  for (const fact of structuredFacts) {
    if (!opts.pathExists(fact.repoKey, fact.file)) {
      throw new Error(
        `${selected.caseId}: structured truth file ${fact.repoKey}/${fact.file} does not exist at the pinned revision.`,
      );
    }
  }

  const paths: string[] = [];
  for (const [key, values] of truthArrays) {
    if (!FILE_TRUTH_KEYS.has(key)) continue;
    paths.push(...values.filter((value): value is string => typeof value === 'string'));
  }
  const chain = params.expectedChain;
  if (Array.isArray(chain)) {
    for (const item of chain) {
      if (item && typeof item === 'object' && typeof (item as { filePath?: unknown }).filePath === 'string') {
        paths.push((item as { filePath: string }).filePath);
      }
    }
  }
  const repoKeys = [
    ...(opts.targetRepoKey ? [opts.targetRepoKey] : []),
    ...Object.keys(selected.cell.repoRevisions ?? {}),
  ].sort(
    (a, b) => b.length - a.length,
  );
  for (const rawPath of paths) {
    const qualifiedRepo = repoKeys.find((repoKey) => rawPath.startsWith(`${repoKey}/`));
    if (qualifiedRepo && qualifiedRepo === opts.targetRepoKey) {
      const qualifiedPath = rawPath.slice(qualifiedRepo.length + 1);
      if (
        opts.pathExists(qualifiedRepo, rawPath) ||
        opts.pathExists(qualifiedRepo, qualifiedPath)
      ) {
        continue;
      }
      throw new Error(
        `${selected.caseId}: truth file ${rawPath} does not exist at the pinned revision.`,
      );
    }
    const repoKey = qualifiedRepo ?? opts.targetRepoKey ?? '';
    const path = qualifiedRepo ? rawPath.slice(qualifiedRepo.length + 1) : rawPath;
    if (!opts.pathExists(repoKey, path)) {
      throw new Error(
        `${selected.caseId}: truth file ${rawPath} does not exist at the pinned revision.`,
      );
    }
  }
}

export interface GraphRevisionOverview {
  gitCommitHash: string | null;
  parsedAt: string | null;
  parserVersion: string | null;
}

export interface GraphOverviewReader {
  overview(repoKey: string): Promise<GraphRevisionOverview>;
}

export interface RevisionAgreement {
  repoKey: string;
  requestedSha: string;
  verifierSha: string;
  agentSha: string | null;
  graphSha: string | null;
}

export interface RevisionPreflight {
  repoKey: string;
  requestedSha: string;
  actualCheckoutSha: string | null;
  localObjectSha: string | null;
  checkoutHeadSha: string | null;
  checkoutTrackedClean: boolean | null;
  graphSha: string;
  parsedAt: string | null;
  parserVersion: string | null;
}

export interface CellPreflight {
  revisions: RevisionPreflight[];
}

function normalized(value: string | null): string | null {
  return value?.toLowerCase() ?? null;
}

export function assertRevisionAgreement(input: RevisionAgreement): string {
  const requested = normalized(input.requestedSha);
  const verifier = normalized(input.verifierSha);
  const agent = normalized(input.agentSha);
  const graph = normalized(input.graphSha);
  if (!requested || verifier !== requested || (agent !== null && agent !== requested) || graph !== requested) {
    throw new Error(
      `Revision preflight failed for ${input.repoKey}: ` +
        `requested=${requested ?? '<missing>'}, verifier=${verifier ?? '<missing>'}, ` +
        `agent=${agent ?? '<no-checkout>'}, graph=${graph ?? '<missing>'}.`,
    );
  }
  return requested;
}

export const defaultGraphOverviewReader: GraphOverviewReader = {
  async overview(repoKey) {
    const repository = await getEvalRepository();
    const rows = await repository.getRepoOverview([await repoHashFor(repoKey)]);
    const overview = rows[0];
    return {
      gitCommitHash: overview?.gitCommitHash ?? null,
      parsedAt: overview?.parsedAt ?? null,
      parserVersion: overview?.parserVersion ?? null,
    };
  },
};

export interface LocalRevisionState {
  objectSha: string;
  headSha: string;
  trackedClean: boolean;
}

export interface PrimaryHistoryReader {
  objectType(repoPath: string, revision: string): Promise<string>;
  isAncestor(repoPath: string, ancestor: string, descendant: string): Promise<boolean>;
  mergeBase(repoPath: string, left: string, right: string): Promise<string>;
  readFile(repoPath: string, revision: string, path: string): Promise<string | null>;
}

function processExitCode(error: unknown): number | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? Number((error as { code?: unknown }).code)
    : undefined;
}

export const defaultPrimaryHistoryReader: PrimaryHistoryReader = {
  async objectType(repoPath, revision) {
    return (await run('git', ['-C', repoPath, 'cat-file', '-t', revision])).stdout.trim();
  },
  async isAncestor(repoPath, ancestor, descendant) {
    try {
      await run('git', ['-C', repoPath, 'merge-base', '--is-ancestor', ancestor, descendant]);
      return true;
    } catch (error) {
      if (processExitCode(error) === 1) return false;
      throw error;
    }
  },
  async mergeBase(repoPath, left, right) {
    return (await run('git', ['-C', repoPath, 'merge-base', left, right])).stdout.trim();
  },
  async readFile(repoPath, revision, path) {
    try {
      return (await run('git', ['-C', repoPath, 'show', `${revision}:${path}`], {
        maxBuffer: 64 * 1024 * 1024,
      })).stdout;
    } catch {
      return null;
    }
  },
};

function symbolCandidates(qualifiedSymbol: string): string[] {
  const leaf = qualifiedSymbol.split('.').at(-1)!;
  return leaf === qualifiedSymbol ? [qualifiedSymbol] : [qualifiedSymbol, leaf];
}

export async function assertPrimaryHistoricalEvidence(opts: {
  repoPath: string;
  repoKey: string;
  targetSha: string;
  selected: SelectedCell;
  history?: PrimaryHistoryReader;
}): Promise<PrimaryRegistration> {
  const registration = assertRegisteredPrimary(opts);
  const history = opts.history ?? defaultPrimaryHistoryReader;
  const objectTypes = await Promise.all([
    history.objectType(opts.repoPath, registration.snapshotCommit),
    history.objectType(opts.repoPath, registration.sourceCommit),
    history.objectType(opts.repoPath, registration.artifactBaseCommit),
  ]);
  for (const [label, type] of [
    ['target', objectTypes[0]],
    ['source', objectTypes[1]],
    ['artifact base', objectTypes[2]],
  ] as const) {
    if (type !== 'commit') {
      throw new Error(`Primary historical preflight: ${label} must resolve to a commit object.`);
    }
  }
  if (
    !(await history.isAncestor(
      opts.repoPath,
      registration.artifactBaseCommit,
      registration.sourceCommit,
    ))
  ) {
    throw new Error('Primary historical preflight: artifact base must be an ancestor of source.');
  }
  const mergeBase = await history.mergeBase(
    opts.repoPath,
    registration.snapshotCommit,
    registration.sourceCommit,
  );
  if (mergeBase.toLowerCase() !== registration.artifactBaseCommit) {
    throw new Error(
      `Primary historical preflight: target/source merge base ${mergeBase} does not equal registered artifact base ${registration.artifactBaseCommit}.`,
    );
  }

  const targetFiles = new Map<string, string>();
  const targetFile = async (path: string): Promise<string> => {
    const cached = targetFiles.get(path);
    if (cached !== undefined) return cached;
    const content = await history.readFile(
      opts.repoPath,
      registration.snapshotCommit,
      path,
    );
    if (content === null) {
      throw new Error(`Primary historical preflight: target file ${path} is missing.`);
    }
    targetFiles.set(path, content);
    return content;
  };

  for (const predicate of registration.sourcePredicates) {
    const [targetContent, sourceContent] = await Promise.all([
      targetFile(predicate.file),
      history.readFile(opts.repoPath, registration.sourceCommit, predicate.file),
    ]);
    if (sourceContent === null) {
      throw new Error(`Primary historical preflight: source file ${predicate.file} is missing.`);
    }
    for (const absent of predicate.targetAbsent) {
      if (targetContent.includes(absent)) {
        throw new Error(
          `Primary historical preflight: target predicate "${absent}" must be absent from ${predicate.file}.`,
        );
      }
    }
    for (const present of predicate.sourcePresent) {
      if (!sourceContent.includes(present)) {
        throw new Error(
          `Primary historical preflight: source predicate "${present}" must be present in ${predicate.file}.`,
        );
      }
    }
  }

  for (const fact of registration.verifier.required) {
    if (!fact.qualifiedSymbol) continue;
    const content = await targetFile(fact.file);
    if (!symbolCandidates(fact.qualifiedSymbol).some((symbol) => content.includes(symbol))) {
      throw new Error(
        `Primary historical preflight: target symbol ${fact.qualifiedSymbol} is missing from ${fact.file}.`,
      );
    }
  }
  return registration;
}

export async function resolveLocalGitRevision(
  repoPath: string,
  revision: string,
): Promise<LocalRevisionState> {
  const objectSha = (await run('git', ['-C', repoPath, 'rev-parse', `${revision}^{commit}`])).stdout.trim();
  const headSha = (await run('git', ['-C', repoPath, 'rev-parse', 'HEAD'])).stdout.trim();
  const status = (await run('git', [
    '-C',
    repoPath,
    'status',
    '--porcelain',
    '--untracked-files=no',
  ])).stdout.trim();
  return { objectSha, headSha, trackedClean: status === '' };
}

function requiredSiblingKeys(selected: SelectedCell, targetRepoKey: string): string[] {
  if (selected.caseId === 'cross-repo-trace') {
    const expected = selected.cell.params.expectedRepos;
    if (!Array.isArray(expected)) return [];
    return expected.filter(
      (repoKey): repoKey is string => typeof repoKey === 'string' && repoKey !== targetRepoKey,
    );
  }
  if (selected.caseId === 'impact-diff') {
    const expected = selected.cell.params.expectedRepos;
    if (Array.isArray(expected)) {
      return expected.filter(
        (repoKey): repoKey is string => typeof repoKey === 'string' && repoKey !== targetRepoKey,
      );
    }
    if (!selected.cell.repoRevisions || Object.keys(selected.cell.repoRevisions).length === 0) {
      throw new Error('impact-diff is a cross-repo cell and requires repoRevisions pins.');
    }
  }
  return [];
}

export async function preflightCell(opts: {
  target: LoadedTarget;
  selected: SelectedCell;
  verifierSha: string;
  agentSha: string | null;
  graph?: GraphOverviewReader;
  accessMode?: AccessMode;
  resolveLocalRevision?: (path: string, revision: string) => Promise<LocalRevisionState>;
  primaryHistory?: PrimaryHistoryReader;
}): Promise<CellPreflight> {
  const requiredMode = opts.selected.cell.requiresAccessMode;
  const invokedMode = opts.accessMode ?? AccessMode.Worktree;
  if (requiredMode !== undefined && invokedMode !== requiredMode) {
    throw new Error(
      `${opts.selected.caseId}: cell requires access mode "${requiredMode}" but the invocation selected "${invokedMode}". ` +
        "The cell's truth is held out of that mode; re-run with the required access mode (never silently downgraded).",
    );
  }
  if (opts.selected.cell.lifecycle === 'primary') {
    await assertPrimaryHistoricalEvidence({
      repoPath: opts.target.path,
      repoKey: opts.target.repoKey,
      targetSha: opts.target.gitSha,
      selected: opts.selected,
      history: opts.primaryHistory,
    });
  }
  const graph = opts.graph ?? defaultGraphOverviewReader;
  const resolveLocal = opts.resolveLocalRevision ?? resolveLocalGitRevision;
  const targetOverview = await graph.overview(opts.target.repoKey);
  const targetSha = assertRevisionAgreement({
    repoKey: opts.target.repoKey,
    requestedSha: opts.target.gitSha,
    verifierSha: opts.verifierSha,
    agentSha: opts.agentSha,
    graphSha: targetOverview.gitCommitHash,
  });
  const revisions: RevisionPreflight[] = [
    {
      repoKey: opts.target.repoKey,
      requestedSha: targetSha,
      actualCheckoutSha: opts.agentSha ?? opts.verifierSha,
      localObjectSha: targetSha,
      checkoutHeadSha: opts.agentSha ?? null,
      checkoutTrackedClean: true,
      graphSha: targetSha,
      parsedAt: targetOverview.parsedAt,
      parserVersion: targetOverview.parserVersion,
    },
  ];

  const pins = opts.selected.cell.repoRevisions ?? {};
  for (const required of requiredSiblingKeys(opts.selected, opts.target.repoKey)) {
    if (!pins[required]) {
      throw new Error(
        `${opts.selected.caseId} expects repository "${required}" but it is absent from repoRevisions.`,
      );
    }
  }
  for (const [repoKey, pin] of Object.entries(pins)) {
    const local = pin.path ? await resolveLocal(pin.path, pin.gitSha) : null;
    const overview = await graph.overview(repoKey);
    const requested = pin.gitSha.toLowerCase();
    if (
      (local !== null && local.objectSha.toLowerCase() !== requested) ||
      normalized(overview.gitCommitHash) !== requested
    ) {
      throw new Error(
        `Revision preflight failed for ${repoKey}: requested=${requested}, ` +
          `localObject=${local?.objectSha ?? '<unavailable>'}, graph=${overview.gitCommitHash ?? '<missing>'}.`,
      );
    }
    if ((opts.accessMode ?? AccessMode.Worktree) === AccessMode.Worktree) {
      if (!local) {
        throw new Error(
          `Revision preflight failed for ${repoKey}: worktree/fleet access requires a pinned local path.`,
        );
      }
      if (local.headSha.toLowerCase() !== requested || !local.trackedClean) {
        throw new Error(
          `Revision preflight failed for ${repoKey}: requested=${requested}, ` +
            `checkout HEAD=${local.headSha}, trackedClean=${local.trackedClean}.`,
        );
      }
    }
    revisions.push({
      repoKey,
      requestedSha: requested,
      actualCheckoutSha: local?.headSha ?? null,
      localObjectSha: local?.objectSha ?? null,
      checkoutHeadSha: local?.headSha ?? null,
      checkoutTrackedClean: local?.trackedClean ?? null,
      graphSha: requested,
      parsedAt: overview.parsedAt,
      parserVersion: overview.parserVersion,
    });
  }
  return { revisions };
}
