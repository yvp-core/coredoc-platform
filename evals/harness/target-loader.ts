import { createHash } from 'node:crypto';
import { compareCodeUnits } from './deterministic-order.js';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { AccessMode } from './types.js';
import type {
  CaseId,
  CellProvenance,
  EvalCell,
  RepoRevisionPin,
  RunnableCell,
  RunnableLifecycle,
  PrimaryAdmission,
  StructuredFact,
  StructuredTruth,
  Target,
} from './types.js';

export const CASE_IDS = [
  'explain-repo',
  'explain-function',
  'blast-radius',
  'entrypoint-deep-dive',
  'entity-impact',
  'data-flow-trace',
  'type-impact',
  'route-deep-dive',
  'route-api-surface',
  'component-decision',
  'cross-repo-trace',
  'feature-implementation-plan',
  'backend-frontend-pair',
  'flag-impact-audit',
  'transitive-callers-closure',
  'service-dependency-map',
  'caller-intersection',
  'entrypoint-permission-audit',
  'deep-chain-side-effects',
  'impact-diff',
] as const satisfies readonly CaseId[];

export const PARAM_KEY_BY_CASE: Record<CaseId, keyof Target['cases']> = {
  'explain-repo': 'explainRepo',
  'explain-function': 'explainFunction',
  'blast-radius': 'blastRadius',
  'entrypoint-deep-dive': 'entrypointDeepDive',
  'entity-impact': 'entityImpact',
  'data-flow-trace': 'dataFlowTrace',
  'type-impact': 'typeImpact',
  'route-deep-dive': 'routeDeepDive',
  'route-api-surface': 'routeApiSurface',
  'component-decision': 'componentDecision',
  'cross-repo-trace': 'crossRepoTrace',
  'feature-implementation-plan': 'featureImplementationPlan',
  'backend-frontend-pair': 'backendFrontendPair',
  'flag-impact-audit': 'flagImpactAudit',
  'transitive-callers-closure': 'transitiveCallersClosure',
  'service-dependency-map': 'serviceDependencyMap',
  'caller-intersection': 'callerIntersection',
  'entrypoint-permission-audit': 'entrypointPermissionAudit',
  'deep-chain-side-effects': 'deepChainSideEffects',
  'impact-diff': 'impactDiff',
};

export interface LoadedTarget extends Target {
  gitSha: string;
  schemaVersion: 2;
  cells: Record<CaseId, EvalCell>;
  manifestPath: string;
  manifestHash: string;
}

export interface SelectedCell {
  caseId: CaseId;
  paramsKey: keyof Target['cases'];
  cell: RunnableCell;
}

const SHA_RE = /^[0-9a-f]{40}$/i;
const RUNNABLE = new Set<RunnableLifecycle>(['primary', 'smoke', 'diagnostic']);

function objectAt(value: unknown, where: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${where} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function stringAt(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${where} must be a non-empty string.`);
  return value;
}

function shaAt(value: unknown, where: string): string {
  const sha = stringAt(value, where);
  if (!SHA_RE.test(sha)) throw new Error(`${where} must be a full 40-character git SHA.`);
  return sha.toLowerCase();
}

function accessModeAt(value: unknown, where: string): AccessMode {
  const raw = stringAt(value, where);
  const modes = Object.values(AccessMode) as string[];
  if (!modes.includes(raw)) {
    throw new Error(`${where} must be one of: ${modes.join(', ')}.`);
  }
  return raw as AccessMode;
}

function containsTbd(value: unknown): boolean {
  if (typeof value === 'string') return /\bTBD\b/i.test(value);
  if (Array.isArray(value)) return value.some(containsTbd);
  if (value && typeof value === 'object') return Object.values(value).some(containsTbd);
  return false;
}

function parsePins(value: unknown, where: string): Record<string, RepoRevisionPin> | undefined {
  if (value === undefined) return undefined;
  const raw = objectAt(value, where);
  const pins: Record<string, RepoRevisionPin> = {};
  for (const [repoKey, candidate] of Object.entries(raw)) {
    if (!repoKey.trim()) throw new Error(`${where} contains an empty repository key.`);
    const pin = objectAt(candidate, `${where}.${repoKey}`);
    pins[repoKey] = {
      gitSha: shaAt(pin.gitSha, `${where}.${repoKey}.gitSha`),
      ...(pin.path === undefined ? {} : { path: stringAt(pin.path, `${where}.${repoKey}.path`) }),
    };
  }
  return pins;
}

function parseAdmission(value: unknown, where: string): PrimaryAdmission {
  const raw = objectAt(value, where);
  const artifact = objectAt(raw.artifact, `${where}.artifact`);
  const kind = stringAt(artifact.kind, `${where}.artifact.kind`);
  const kinds = ['issue', 'pr', 'incident', 'security-audit', 'deprecation', 'migration'] as const;
  if (!(kinds as readonly string[]).includes(kind)) {
    throw new Error(`${where}.artifact.kind must be one of: ${kinds.join(', ')}.`);
  }
  // Registration is enforced by assertRegisteredPrimary at every primary gate.
  const verifierId = stringAt(raw.verifierId, `${where}.verifierId`);
  return {
    artifact: {
      kind: kind as PrimaryAdmission['artifact']['kind'],
      ref: stringAt(artifact.ref, `${where}.artifact.ref`),
    },
    observer: stringAt(raw.observer, `${where}.observer`),
    decision: stringAt(raw.decision, `${where}.decision`),
    verifierId,
  };
}

function optionalString(value: unknown, where: string): string | undefined {
  return value === undefined ? undefined : stringAt(value, where);
}

function parseStructuredFact(value: unknown, where: string): StructuredFact {
  const raw = objectAt(value, where);
  const method = optionalString(raw.method, `${where}.method`);
  const path = optionalString(raw.path, `${where}.path`);
  if ((method === undefined) !== (path === undefined)) {
    throw new Error(`${where}: method and path must be provided together.`);
  }
  const depth = raw.depth;
  if (depth !== undefined && (typeof depth !== 'number' || !Number.isFinite(depth) || depth < 0)) {
    throw new Error(`${where}.depth must be a finite non-negative number.`);
  }
  const fact: StructuredFact = {
    repoKey: stringAt(raw.repoKey, `${where}.repoKey`),
    gitSha: shaAt(raw.gitSha, `${where}.gitSha`),
    file: stringAt(raw.file, `${where}.file`),
    ...(optionalString(raw.qualifiedSymbol, `${where}.qualifiedSymbol`) === undefined
      ? {}
      : { qualifiedSymbol: optionalString(raw.qualifiedSymbol, `${where}.qualifiedSymbol`)! }),
    ...(optionalString(raw.relation, `${where}.relation`) === undefined
      ? {}
      : { relation: optionalString(raw.relation, `${where}.relation`)! }),
    ...(method === undefined ? {} : { method: method.toUpperCase(), path: path! }),
    ...(depth === undefined ? {} : { depth }),
    ...(optionalString(raw.effect, `${where}.effect`) === undefined
      ? {}
      : { effect: optionalString(raw.effect, `${where}.effect`)! }),
    ...(optionalString(raw.useKind, `${where}.useKind`) === undefined
      ? {}
      : { useKind: optionalString(raw.useKind, `${where}.useKind`)! }),
  };
  if (
    fact.qualifiedSymbol === undefined &&
    fact.relation === undefined &&
    fact.method === undefined &&
    fact.depth === undefined &&
    fact.effect === undefined &&
    fact.useKind === undefined
  ) {
    throw new Error(
      `${where} requires a semantic discriminator (qualifiedSymbol, relation, method+path, depth, effect, or useKind).`,
    );
  }
  return fact;
}

function parseStructuredTruth(value: unknown, where: string, requireFacts: boolean): StructuredTruth {
  const raw = objectAt(value, where);
  const parsed = {} as StructuredTruth;
  const seen = new Set<string>();
  for (const key of ['required', 'accepted', 'forbidden'] as const) {
    const candidates = raw[key];
    if (!Array.isArray(candidates)) throw new Error(`${where}.${key} must be an explicit array.`);
    if (key === 'required' && requireFacts && candidates.length === 0) {
      throw new Error(`${where}.required must contain at least one structured fact.`);
    }
    parsed[key] = candidates.map((candidate, index) => {
      const fact = parseStructuredFact(candidate, `${where}.${key}[${index}]`);
      const identity = stableJson(fact);
      if (seen.has(identity)) throw new Error(`${where}: duplicate structured fact in ${key}.`);
      seen.add(identity);
      return fact;
    });
  }
  return parsed;
}

function parseCell(value: unknown, where: string, caseId: CaseId): EvalCell {
  const raw = objectAt(value, where);
  if (containsTbd(raw)) throw new Error(`${where} contains forbidden magic TBD data.`);
  const lifecycle = stringAt(raw.lifecycle, `${where}.lifecycle`);
  if (lifecycle === 'quarantine') {
    if ('params' in raw) throw new Error(`${where}: quarantine cells must not contain params.`);
    if ('requiresAccessMode' in raw) {
      throw new Error(`${where}: quarantine cells must not contain requiresAccessMode.`);
    }
    return {
      lifecycle,
      reasonCode: stringAt(raw.reasonCode, `${where}.reasonCode`),
      reason: stringAt(raw.reason, `${where}.reason`),
    };
  }
  if (!RUNNABLE.has(lifecycle as RunnableLifecycle)) {
    throw new Error(`${where}.lifecycle must be primary, smoke, diagnostic, or quarantine.`);
  }
  const params = objectAt(raw.params, `${where}.params`);
  if (
    Object.keys(params).length === 0 &&
    !(caseId === 'explain-repo' && lifecycle === 'smoke')
  ) {
    throw new Error(`${where}.params must not be empty.`);
  }
  if (containsTbd(params)) throw new Error(`${where}.params contains forbidden magic TBD data.`);
  const provenance = objectAt(raw.provenance, `${where}.provenance`);
  const kind = stringAt(provenance.kind, `${where}.provenance.kind`);
  if (!['source-audit', 'counterfactual', 'historical-diff'].includes(kind)) {
    throw new Error(
      `${where}.provenance.kind must be source-audit, counterfactual, or historical-diff.`,
    );
  }
  const evidence = provenance.evidence;
  if (!Array.isArray(evidence) || evidence.length === 0 || evidence.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error(`${where}.provenance.evidence must contain at least one non-empty string.`);
  }
  const repoRevisions = parsePins(raw.repoRevisions, `${where}.repoRevisions`);
  const requiresAccessMode = raw.requiresAccessMode === undefined
    ? undefined
    : accessModeAt(raw.requiresAccessMode, `${where}.requiresAccessMode`);
  const admission = lifecycle === 'primary'
    ? parseAdmission(raw.admission, `${where}.admission`)
    : undefined;
  const truth = raw.truth === undefined
    ? lifecycle === 'primary'
      ? parseStructuredTruth(raw.truth, `${where}.truth`, true)
      : undefined
    : parseStructuredTruth(raw.truth, `${where}.truth`, lifecycle === 'primary');
  const sourceCommit = provenance.sourceCommit === undefined
    ? undefined
    : shaAt(provenance.sourceCommit, `${where}.provenance.sourceCommit`);
  const artifactBaseCommit = provenance.artifactBaseCommit === undefined
    ? undefined
    : shaAt(provenance.artifactBaseCommit, `${where}.provenance.artifactBaseCommit`);
  if (kind === 'historical-diff' && sourceCommit === undefined) {
    throw new Error(`${where}.provenance.sourceCommit is required for historical-diff provenance.`);
  }
  if (kind === 'historical-diff' && artifactBaseCommit === undefined) {
    throw new Error(
      `${where}.provenance.artifactBaseCommit is required for historical-diff provenance.`,
    );
  }
  return {
    lifecycle: lifecycle as RunnableLifecycle,
    provenance: {
      kind: kind as CellProvenance['kind'],
      snapshotCommit: shaAt(provenance.snapshotCommit, `${where}.provenance.snapshotCommit`),
      ...(artifactBaseCommit === undefined ? {} : { artifactBaseCommit }),
      ...(sourceCommit === undefined ? {} : { sourceCommit }),
      evidence: [...evidence] as string[],
    },
    params,
    ...(admission ? { admission } : {}),
    ...(truth ? { truth } : {}),
    ...(repoRevisions ? { repoRevisions } : {}),
    ...(requiresAccessMode ? { requiresAccessMode } : {}),
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => compareCodeUnits(a, b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function parseTargetManifest(
  value: unknown,
  manifestPath: string,
  exactBytes?: string | Buffer,
): LoadedTarget {
  const raw = objectAt(value, manifestPath);
  if (raw.schemaVersion !== 2) {
    throw new Error(`${manifestPath}: schemaVersion 2 is required; legacy target manifests are not runnable.`);
  }
  const path = stringAt(raw.path, `${manifestPath}.path`);
  if (containsTbd(path)) throw new Error(`${manifestPath}.path contains forbidden magic TBD data.`);
  const repoKey = stringAt(raw.repoKey, `${manifestPath}.repoKey`);
  const gitSha = shaAt(raw.gitSha, `${manifestPath}.gitSha`);
  const rawCells = objectAt(raw.cells, `${manifestPath}.cells`);
  const names = Object.keys(rawCells).sort();
  const expected = [...CASE_IDS].sort();
  if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) {
    throw new Error(`${manifestPath}: cells must contain exactly the ${CASE_IDS.length} canonical case ids.`);
  }
  const cells = Object.fromEntries(
    CASE_IDS.map((id) => [id, parseCell(rawCells[id], `${manifestPath}.cells.${id}`, id)]),
  ) as Record<CaseId, EvalCell>;
  const cases = Object.fromEntries(
    CASE_IDS.flatMap((id) => {
      const cell = cells[id];
      return cell.lifecycle === 'quarantine' ? [] : [[PARAM_KEY_BY_CASE[id], cell.params]];
    }),
  ) as unknown as Target['cases'];
  for (const caseId of CASE_IDS) {
    const cell = cells[caseId];
    if (cell.lifecycle !== 'quarantine' && cell.provenance.snapshotCommit !== gitSha) {
      throw new Error(
        `${manifestPath}.cells.${caseId}.provenance.snapshotCommit must equal target gitSha ${gitSha}.`,
      );
    }
    if (cell.lifecycle === 'quarantine' || !cell.truth) continue;
    for (const fact of [
      ...cell.truth.required,
      ...cell.truth.accepted,
      ...cell.truth.forbidden,
    ]) {
      const expectedSha =
        fact.repoKey === repoKey ? gitSha : cell.repoRevisions?.[fact.repoKey]?.gitSha;
      if (!expectedSha) {
        throw new Error(
          `${manifestPath}.cells.${caseId}: structured fact repository ${fact.repoKey} is absent from repoRevisions.`,
        );
      }
      if (fact.gitSha !== expectedSha) {
        throw new Error(
          `${manifestPath}.cells.${caseId}: structured fact gitSha ${fact.gitSha} does not match ${fact.repoKey === repoKey ? 'target' : 'pinned repository'} SHA ${expectedSha}.`,
        );
      }
    }
  }
  return {
    schemaVersion: 2,
    name: stringAt(raw.name, `${manifestPath}.name`),
    path,
    ...(raw.baseBranch === undefined
      ? {}
      : { baseBranch: stringAt(raw.baseBranch, `${manifestPath}.baseBranch`) }),
    repoKey,
    gitSha,
    cases,
    cells,
    manifestPath,
    manifestHash: createHash('sha256').update(exactBytes ?? stableJson(raw)).digest('hex'),
  };
}

export function parseTargetManifestText(text: string, manifestPath: string): LoadedTarget {
  return parseTargetManifest(JSON.parse(text), manifestPath, text);
}

export function parseLifecycleSelection(raw: string | undefined): Set<RunnableLifecycle> {
  if (!raw) return new Set(['primary']);
  const values = raw.split(',').map((value) => value.trim()).filter(Boolean);
  if (values.includes('quarantine')) throw new Error('Lifecycle quarantine cannot be selected for execution.');
  for (const value of values) {
    if (!RUNNABLE.has(value as RunnableLifecycle)) {
      throw new Error(`Unknown lifecycle "${value}". Expected primary, smoke, or diagnostic.`);
    }
  }
  if (values.length === 0) throw new Error('At least one runnable lifecycle must be selected.');
  return new Set(values as RunnableLifecycle[]);
}

export function selectRunnableCells(
  target: LoadedTarget,
  lifecycles: ReadonlySet<RunnableLifecycle>,
): SelectedCell[] {
  return CASE_IDS.flatMap((caseId) => {
    const cell = target.cells[caseId];
    if (cell.lifecycle === 'quarantine' || !lifecycles.has(cell.lifecycle)) return [];
    return [{ caseId, paramsKey: PARAM_KEY_BY_CASE[caseId], cell }];
  });
}

export function loadTargets(targetsDir: string, reposRoot: string): LoadedTarget[] {
  // `targets/ignored/` holds local-only manifests (gitignored so they cannot be
  // pushed by accident); they are first-class selectable targets locally.
  const ignoredDir = join(targetsDir, 'ignored');
  const manifestFiles = [
    ...listManifestFiles(targetsDir),
    ...(existsSync(ignoredDir) ? listManifestFiles(ignoredDir) : []),
  ];
  const targets = manifestFiles.map(({ dir, file }) => {
    const manifestPath = join(dir, file);
    const target = parseTargetManifestText(readFileSync(manifestPath, 'utf8'), manifestPath);
    if (!isAbsolute(target.path)) target.path = resolve(reposRoot, target.path);
    for (const cell of Object.values(target.cells)) {
      if (cell.lifecycle === 'quarantine') continue;
      for (const pin of Object.values(cell.repoRevisions ?? {})) {
        if (pin.path && !isAbsolute(pin.path)) pin.path = resolve(reposRoot, pin.path);
      }
    }
    return target;
  });
  const seen = new Map<string, string>();
  for (const target of targets) {
    const previous = seen.get(target.name);
    if (previous) {
      throw new Error(
        `Duplicate target name "${target.name}" in ${previous} and ${target.manifestPath}: ` +
          'a tracked manifest and a targets/ignored manifest may not share a name.',
      );
    }
    seen.set(target.name, target.manifestPath);
  }
  return targets;
}

function listManifestFiles(dir: string): Array<{ dir: string; file: string }> {
  return readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => ({ dir, file }));
}
