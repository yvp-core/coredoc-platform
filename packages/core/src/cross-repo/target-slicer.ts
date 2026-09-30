/**
 * Push-time target slicing (spec §4.4).
 *
 * A multi-target parse merges a monorepo's several profile targets into ONE
 * `ParsedRepo`: its ts frontend `externalCalls` and its py/ruby backend
 * `entrypoints` live side by side, distinguished only by `FileNode.target`
 * (stamped by `mergeParsedRepos`, Phase 1). The workspace linker resolves
 * transport-level calls BETWEEN `ParsedRepoLike`s — so to link a monorepo's
 * ui→backend edges we slice the one merged repo into one `ParsedRepoLike` per
 * target (a "service"), each carrying only the nodes its target claimed. The
 * linker then treats the slices as ordinary workspace members; a ui→api hop is
 * a cross-slice edge exactly like a cross-repo one.
 *
 * Non-multi-target repos (no file carries a `target`) return a single slice that
 * is byte-compatible with today's un-sliced `ParsedRepoLike`, so every existing
 * single-repo project links unchanged.
 */

import type {
  CallEdge,
  ClassNode,
  Entrypoint,
  EnumNode,
  ExternalCallEdge,
  FileNode,
  FunctionNode,
  ImportEdge,
  InterfaceNode,
  Package,
  ParsedRepo,
  TypeAliasNode,
  VariableNode,
} from '../types/output.js';
import type { ParsedRepoLike } from './linker.js';
import type { ServiceEntry } from './mapper-schema.js';

/**
 * The parsed-repo fields the slicer reads — the exact subset
 * `resolveProjectCrossRepo` already loads (`loadProjectParsedRepos` returns full
 * `ParsedRepo`s). Derived from `ParsedRepo`, not a parallel shape, so the loader's
 * output flows straight in.
 */
export type ParsedRepoDataForLinking = Pick<
  ParsedRepo,
  'id' | 'name' | 'type' | 'entrypoints' | 'externalCalls' | 'functions' | 'files'
> &
  Partial<
    Pick<
      ParsedRepo,
      'packages' | 'imports' | 'classes' | 'interfaces' | 'typeAliases' | 'enums' | 'variables' | 'calls'
    >
  >;

/** One target's slice of a merged repo: the target name (undefined for a whole-repo slice) + its `ParsedRepoLike`. */
export interface TargetSlice {
  /** Profile target this slice represents; undefined for a non-multi-target repo or the synthetic unattributed slice. */
  target: string | undefined;
  repoLike: ParsedRepoLike;
}

interface Bucket {
  entrypoints: Entrypoint[];
  externalCalls: ExternalCallEdge[];
  calls: CallEdge[];
  functions: FunctionNode[];
  files: FileNode[];
  imports: ImportEdge[];
  classes: ClassNode[];
  interfaces: InterfaceNode[];
  typeAliases: TypeAliasNode[];
  enums: EnumNode[];
  variables: VariableNode[];
}

function emptyBucket(): Bucket {
  return {
    entrypoints: [],
    externalCalls: [],
    calls: [],
    functions: [],
    files: [],
    imports: [],
    classes: [],
    interfaces: [],
    typeAliases: [],
    enums: [],
    variables: [],
  };
}

/**
 * Split a (possibly merged multi-target) parsed repo into one `ParsedRepoLike`
 * per profile target (spec §4.4).
 *
 * - Not multi-target → one slice with unchanged protocol-link behavior and the
 *   repo's package-import facts carried through.
 * - Multi-target → one slice per distinct `FileNode.target`, attributing
 *   entrypoints (handler fn's fileId, fallback `location.filePath`), externalCalls
 *   (callerId→fn's fileId, same fallback), and functions (fileId). Nodes whose file
 *   carries no target land in a synthetic `<repo>` slice and are counted +
 *   warned (never thrown on, never dropped — an attribution bug must stay visible).
 * - Service naming: mapper `(repo, target)` row → `name`; else default `"<repo>#<target>"`.
 * - Prefix: matching `ServiceEntry.httpPrefix` ?? `fallbackPrefix` (`RepoConfig.httpPrefix`).
 */
export function sliceParsedRepoByTarget(
  repo: ParsedRepoDataForLinking,
  serviceEntries: ServiceEntry[],
  fallbackPrefix?: string,
): TargetSlice[] {
  // `files`/`functions` are typed non-optional but on-disk parsed JSON can predate
  // those fields (older parser output); the loaders guard `r.files ?? []` for the
  // same reason. Normalize here so a partial repo degrades to a single/empty slice
  // instead of throwing and aborting the whole workspace link.
  const repoFiles = repo.files ?? [];
  const repoFunctions = repo.functions ?? [];
  const isMultiTarget = repoFiles.some((f) => f.target !== undefined);

  // Non-multi-target: single slice with protocol fields identical to the
  // pre-package-link repoLike. The
  // repo-level (target-absent) service entry may still override the prefix (§4.3
  // precedence); for an all-v1 mapper there is none, so this is fallbackPrefix —
  // behavior-compatible with today.
  if (!isMultiTarget) {
    const repoEntry = serviceEntries.find((s) => s.target === undefined);
    return [
      {
        target: undefined,
        repoLike: {
          id: repo.id,
          name: repo.name,
          repositoryName: repo.name,
          entrypoints: repo.entrypoints,
          externalCalls: repo.externalCalls,
          calls: repo.calls ?? [],
          functions: repoFunctions,
          packages: repo.packages ?? [],
          files: repoFiles,
          imports: repo.imports ?? [],
          classes: repo.classes ?? [],
          interfaces: repo.interfaces ?? [],
          typeAliases: repo.typeAliases ?? [],
          enums: repo.enums ?? [],
          variables: repo.variables ?? [],
          type: repo.type,
          httpPrefix: repoEntry?.httpPrefix ?? fallbackPrefix,
        },
      },
    ];
  }

  // --- Attribution indexes ---
  const targetByFileId = new Map<string, string | undefined>();
  const targetByPath = new Map<string, string | undefined>();
  for (const f of repoFiles) {
    targetByFileId.set(f.id, f.target);
    targetByPath.set(f.path, f.target);
  }
  const fileIdByFunctionId = new Map<string, string>();
  for (const fn of repoFunctions) fileIdByFunctionId.set(fn.id, fn.fileId);

  // Resolve a node's target via its owning function's fileId, falling back to a
  // path lookup when the function is not indexed (synthetic handlers with no
  // FunctionNode — e.g. Ruby http entrypoints). undefined = unattributed.
  const targetOf = (functionId: string | undefined, filePath: string): string | undefined => {
    if (functionId !== undefined) {
      const fileId = fileIdByFunctionId.get(functionId);
      if (fileId !== undefined) return targetByFileId.get(fileId);
    }
    return targetByPath.get(filePath);
  };

  const buckets = new Map<string, Bucket>();
  const synthetic = emptyBucket();
  let unattributed = 0;

  // Route a node to its target bucket, or the synthetic bucket when unattributed.
  const bucketFor = (target: string | undefined): Bucket => {
    if (target === undefined) {
      unattributed += 1;
      return synthetic;
    }
    let b = buckets.get(target);
    if (!b) {
      b = emptyBucket();
      buckets.set(target, b);
    }
    return b;
  };

  // A package-import provider may contain only type declarations, and a
  // consumer target may contain only imports. Targeted files therefore create
  // buckets even when protocol facts (functions/entrypoints/calls) are absent.
  for (const file of repoFiles) {
    if (file.target !== undefined) bucketFor(file.target).files.push(file);
  }

  for (const ep of repo.entrypoints) {
    bucketFor(targetOf(ep.handlerId, ep.location.filePath)).entrypoints.push(ep);
  }
  for (const ec of repo.externalCalls) {
    bucketFor(targetOf(ec.callerId, ec.location.filePath)).externalCalls.push(ec);
  }
  for (const call of repo.calls ?? []) {
    // CALLS edges are hop EVIDENCE, not linkable nodes: an unattributed one is
    // skipped rather than forcing a synthetic slice into existence.
    const target = targetOf(call.callerId, call.location.filePath);
    if (target !== undefined) bucketFor(target).calls.push(call);
  }
  for (const fn of repoFunctions) {
    // Functions attribute directly by fileId (fallback: their own location path).
    const target = targetByFileId.has(fn.fileId)
      ? targetByFileId.get(fn.fileId)
      : targetByPath.get(fn.location.filePath);
    bucketFor(target).functions.push(fn);
  }
  for (const imported of repo.imports ?? []) {
    bucketFor(targetByFileId.get(imported.sourceFileId)).imports.push(imported);
  }
  for (const node of repo.classes ?? []) bucketFor(targetByFileId.get(node.fileId)).classes.push(node);
  for (const node of repo.interfaces ?? []) bucketFor(targetByFileId.get(node.fileId)).interfaces.push(node);
  for (const node of repo.typeAliases ?? []) bucketFor(targetByFileId.get(node.fileId)).typeAliases.push(node);
  for (const node of repo.enums ?? []) bucketFor(targetByFileId.get(node.fileId)).enums.push(node);
  for (const node of repo.variables ?? []) bucketFor(targetByFileId.get(node.fileId)).variables.push(node);

  // When operational/package facts already forced an unattributed bucket,
  // retain its untagged files so their packageId/path joins stay possible.
  if (
    synthetic.entrypoints.length > 0 ||
    synthetic.externalCalls.length > 0 ||
    synthetic.functions.length > 0 ||
    synthetic.imports.length > 0 ||
    synthetic.classes.length > 0 ||
    synthetic.interfaces.length > 0 ||
    synthetic.typeAliases.length > 0 ||
    synthetic.enums.length > 0 ||
    synthetic.variables.length > 0
  ) {
    synthetic.files.push(...repoFiles.filter((file) => file.target === undefined));
  }

  const entryFor = (target: string): ServiceEntry | undefined => serviceEntries.find((s) => s.target === target);
  const repoEntry = serviceEntries.find((s) => s.target === undefined);

  const slices: TargetSlice[] = [];
  const packagesFor = (bucket: Bucket): Package[] => {
    const packageIds = new Set(bucket.files.map((file) => file.packageId));
    return (repo.packages ?? []).filter((pkg) => packageIds.has(pkg.id));
  };
  // Deterministic target order regardless of node iteration order.
  for (const target of [...buckets.keys()].sort()) {
    const bucket = buckets.get(target)!;
    const entry = entryFor(target);
    slices.push({
      target,
      repoLike: {
        id: repo.id,
        name: entry?.name ?? `${repo.name}#${target}`,
        repositoryName: repo.name,
        entrypoints: bucket.entrypoints,
        externalCalls: bucket.externalCalls,
        calls: bucket.calls,
        functions: bucket.functions,
        packages: packagesFor(bucket),
        files: bucket.files,
        imports: bucket.imports,
        classes: bucket.classes,
        interfaces: bucket.interfaces,
        typeAliases: bucket.typeAliases,
        enums: bucket.enums,
        variables: bucket.variables,
        type: repo.type,
        // Precedence (§4.3): the target's own service entry, then the repo-level
        // (target-undefined) entry, then the RepoConfig fallback — same tiering the
        // single-target and synthetic-slice branches use, so a repo-level prefix is
        // not silently dropped for named per-target slices.
        httpPrefix: entry?.httpPrefix ?? repoEntry?.httpPrefix ?? fallbackPrefix,
      },
    });
  }

  // Synthetic unattributed slice — assigned the bare repo name, never dropped.
  if (
    synthetic.entrypoints.length > 0 ||
    synthetic.externalCalls.length > 0 ||
    synthetic.functions.length > 0 ||
    synthetic.imports.length > 0 ||
    synthetic.classes.length > 0 ||
    synthetic.interfaces.length > 0 ||
    synthetic.typeAliases.length > 0 ||
    synthetic.enums.length > 0 ||
    synthetic.variables.length > 0
  ) {
    // Structured, visible signal — an unattributed node in a multi-target repo is
    // an attribution bug, surfaced (not thrown: push must not be DoS-able by one
    // bad node) so it can be investigated.
    console.warn(
      `  target-slicer: ${unattributed} node(s) in multi-target repo "${repo.name}" had no target attribution; ` +
        `assigned to synthetic "${repo.name}" slice (unattributed bucket).`,
    );
    slices.push({
      target: undefined,
      repoLike: {
        id: repo.id,
        name: repo.name,
        repositoryName: repo.name,
        entrypoints: synthetic.entrypoints,
        externalCalls: synthetic.externalCalls,
        calls: synthetic.calls,
        functions: synthetic.functions,
        packages: packagesFor(synthetic),
        files: synthetic.files,
        imports: synthetic.imports,
        classes: synthetic.classes,
        interfaces: synthetic.interfaces,
        typeAliases: synthetic.typeAliases,
        enums: synthetic.enums,
        variables: synthetic.variables,
        type: repo.type,
        httpPrefix: repoEntry?.httpPrefix ?? fallbackPrefix,
      },
    });
  }

  return slices;
}
