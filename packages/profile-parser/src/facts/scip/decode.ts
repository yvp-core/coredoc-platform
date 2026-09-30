import { readFileSync } from 'node:fs';
import { fromBinary } from '@bufbuild/protobuf';
import { configureTextEncoding, getTextEncoding } from '@bufbuild/protobuf/wire';
import { type Index, IndexSchema } from '@scip-code/scip';

export interface ScipRange {
  startLine: number;
  startChar: number;
  endLine: number;
  endChar: number;
}

export type ParsedMoniker =
  | { local: string }
  | { scheme: string; manager: string; packageName: string; version: string; descriptors: string };

const SYMBOL_ROLE_DEFINITION = 0x1;

export function isDefinition(symbolRoles: number): boolean {
  return (symbolRoles & SYMBOL_ROLE_DEFINITION) !== 0;
}

/** Decode the packed range int array (zero-based). 3 ints = single line, 4 ints = multi-line. */
export function decodeRange(range: number[]): ScipRange {
  if (range.length === 3) {
    return { startLine: range[0], startChar: range[1], endLine: range[0], endChar: range[2] };
  }
  if (range.length === 4) {
    return { startLine: range[0], startChar: range[1], endLine: range[2], endChar: range[3] };
  }
  throw new Error(`unexpected SCIP range arity: ${range.length}`);
}

/**
 * Parse a SCIP symbol string. Spaces inside a field are escaped by doubling;
 * `.` is the empty placeholder. For call-edge purposes we only need the package
 * identity, so we split the leading 4 space-delimited tokens and keep the rest as descriptors.
 */
export function parseMoniker(symbol: string): ParsedMoniker {
  if (symbol.startsWith('local ')) {
    return { local: symbol.slice('local '.length).trim() };
  }
  // Split on single spaces that are not part of a doubled-space escape.
  const tokens = symbol.split(/ (?! )/);
  const [scheme, manager, packageName, version, ...rest] = tokens;
  return {
    scheme: scheme ?? '',
    manager: manager === '.' ? '' : (manager ?? ''),
    packageName: packageName === '.' ? '' : (packageName ?? ''),
    version: version === '.' ? '' : (version ?? ''),
    descriptors: rest.join(' '),
  };
}

/**
 * The file component of a SCIP descriptor chain: a backtick-wrapped segment whose
 * content ends in a TS/JS source or declaration extension (`.ts`, `.tsx`, `.d.ts`,
 * `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.d.mts`, …), followed by `/`.
 * scip-typescript always backtick-wraps a filename (it contains a `.`), so this
 * isolates the file even when a later descriptor is itself backtick-wrapped (an
 * ECMAScript private name like `` `#foo`() ``). Capture group 1 is everything after it.
 */
const FILE_DESCRIPTOR_RE = /`[^`]*\.(?:d\.)?[cm]?[jt]sx?`\/(.+)$/;

/**
 * The symbol-descriptor SUFFIX after the file component of a moniker's descriptors —
 * the `Type#method().` / `fn().` chain that identifies a symbol WITHIN its package,
 * independent of which file declares it. A cross-package reference resolves through a
 * workspace package's PUBLISHED declarations (`dist/x.d.ts`) while the definition lives
 * in source (`src/x.ts`): the file part differs (`dist/`x.d.ts`` vs `src/`x.ts``) but this
 * suffix is identical, making it the stable cross-file join key. Returns undefined when the
 * descriptors carry no recognizable file component (e.g. a bare/local symbol).
 */
export function descriptorSuffixAfterFile(descriptors: string): string | undefined {
  return descriptors.match(FILE_DESCRIPTOR_RE)?.[1];
}

/**
 * Cross-package definition key for a workspace-internal symbol: `<packageName> <suffix>`,
 * where suffix is {@link descriptorSuffixAfterFile}. Joins a consumer's dist-declaration
 * reference onto the in-repo SOURCE definition of the same exported symbol, so a call across
 * a workspace-package boundary (`@scope/pkg` → `packages/pkg/src/...`) resolves to an internal
 * edge instead of being misread as an external SDK call. Returns undefined for a `local`
 * symbol, an empty-package (TS stdlib) symbol, or a symbol with no file/suffix — none of which
 * participate in cross-package workspace resolution. Only workspace packages carry a DEFINITION
 * occurrence in the index (their source is indexed), so keys built from definitions never
 * collide with a genuine external package (which has none).
 */
export function packageSymbolKey(symbol: string): string | undefined {
  const mon = parseMoniker(symbol);
  if ('local' in mon) return undefined;
  if (!mon.packageName) return undefined;
  const suffix = descriptorSuffixAfterFile(mon.descriptors);
  return suffix ? `${mon.packageName} ${suffix}` : undefined;
}

export interface LoadedScip {
  projectRoot: string;
  documents: {
    relativePath: string;
    /** SCIP PositionEncoding: 1 = UTF-8 bytes, 2 = UTF-16 code units. */
    positionEncoding?: number;
    occurrences: { symbol: string; symbolRoles: number; range: number[] }[];
    /** Compiler-declared implementation relationships, when present in the index. */
    symbols?: { symbol: string; relationships: { symbol: string; isImplementation: boolean }[] }[];
  }[];
  /**
   * Present only when the index would NOT decode under protobuf's strict UTF-8 validation and
   * was re-decoded with a non-fatal decoder (invalid byte sequences replaced by U+FFFD).
   * `invalidStrings` is how many string fields needed the replacement.
   */
  lenientUtf8?: { invalidStrings: number };
}

interface TypedRangeOccurrence {
  singleLineRange?: { line: number; startCharacter: number; endCharacter: number };
  multiLineRange?: { startLine: number; startCharacter: number; endLine: number; endCharacter: number };
}

/**
 * Decode `bytes` with protobuf's UTF-8 validation turned OFF, counting the string fields that
 * needed it. Only the WHOLE-string outcome differs from a strict decode: an invalid byte sequence
 * becomes U+FFFD instead of throwing; framing, tags and lengths are read identically, so a
 * truncated or otherwise corrupt index still fails here.
 *
 * The seam is `configureTextEncoding` from `@bufbuild/protobuf/wire` (protobuf-es 2.12): the
 * library reads strings through a process-global `TextEncoding` object, and `BinaryReadOptions`
 * (v2.12: `readUnknownFields` only) offers no reader/decoder injection point. The override is
 * therefore installed around this one synchronous decode and restored in `finally` — nothing can
 * interleave, because there is no await between.
 */
function decodeLenientUtf8(bytes: Uint8Array): DecodedScipIndex {
  const previous = getTextEncoding();
  const nonFatal = new TextDecoder('utf-8', { fatal: false });
  let invalidStrings = 0;
  configureTextEncoding({
    ...previous,
    decodeUtf8(data: Uint8Array, strict?: boolean) {
      if (!strict) return previous.decodeUtf8(data, false);
      try {
        return previous.decodeUtf8(data, true);
      } catch {
        invalidStrings++;
        return nonFatal.decode(data);
      }
    },
  });
  try {
    return { index: fromBinary(IndexSchema, bytes), invalidStrings };
  } finally {
    configureTextEncoding(previous);
  }
}

interface DecodedScipIndex {
  index: Index;
  /** How many string fields were only readable with UTF-8 validation off; 0 = a clean strict decode. */
  invalidStrings: number;
}

/**
 * Decode a .scip protobuf index, translating the raw protobuf failure of a
 * truncated/corrupt index into an actionable error. A half-written index (an
 * interrupted or concurrent scip-typescript run) must surface as "re-index",
 * not a cryptic 'illegal tag'.
 *
 * A strict-decode failure gets ONE lenient retry (see {@link decodeLenientUtf8}), which is
 * accepted only if it both succeeds AND actually found invalid UTF-8 — that conjunction is what
 * identifies the failure as a UTF-8-validity failure, without matching on a runtime's error text.
 * Measured case: posthog's `nodejs` project indexes reproducibly but carries a string that is not
 * valid UTF-8, so the index is otherwise perfectly good and losing it costs that project's whole
 * call graph. A genuinely corrupt index fails the retry too and keeps the actionable throw.
 */
function decodeScipIndex(scipPath: string, bytes: Uint8Array): DecodedScipIndex {
  try {
    return { index: fromBinary(IndexSchema, bytes), invalidStrings: 0 };
  } catch (err) {
    try {
      const lenient = decodeLenientUtf8(bytes);
      if (lenient.invalidStrings > 0) return lenient;
    } catch {
      // Not a UTF-8 problem — fall through to the corrupt-index error below.
    }
    throw new Error(
      `Failed to decode SCIP index at ${scipPath} — it is corrupt or incomplete (likely an ` +
        `interrupted or concurrent scip-typescript run). Delete it and re-index. Cause: ${String(err)}`,
    );
  }
}

/** Load and minimally normalize a .scip file. */
export function loadScip(scipPath: string, bytes: Uint8Array = readFileSync(scipPath)): LoadedScip {
  const { index, invalidStrings } = decodeScipIndex(scipPath, bytes);
  return {
    projectRoot: index.metadata?.projectRoot ?? '',
    documents: index.documents.map((d) => ({
      relativePath: d.relativePath,
      ...(d.positionEncoding ? { positionEncoding: d.positionEncoding } : {}),
      ...(d.symbols.some((s) => s.relationships.some((r) => r.isImplementation))
        ? {
            symbols: d.symbols
              .filter((s) => s.relationships.some((r) => r.isImplementation))
              .map((s) => ({
                symbol: s.symbol,
                relationships: s.relationships
                  .filter((r) => r.isImplementation)
                  .map((r) => ({ symbol: r.symbol, isImplementation: true })),
              })),
          }
        : {}),
      occurrences: d.occurrences.map((o) => ({
        symbol: o.symbol,
        symbolRoles: o.symbolRoles,
        // prefer packed range; typed ranges are an alternative not all indexers emit
        range: o.range?.length ? Array.from(o.range) : typedRange(o as unknown as TypedRangeOccurrence),
      })),
    })),
    ...(invalidStrings > 0 ? { lenientUtf8: { invalidStrings } } : {}),
  };
}

/** A merged multi-index load: a LoadedScip plus what the merge had to drop. */
export interface MergedScip extends LoadedScip {
  /** Documents skipped because another index already covered that relative path. */
  duplicateDocuments: number;
  /**
   * Of the deduped paths, how many had NO owner by the path-prefix rule (no claiming
   * project's dir is an ancestor of the file — a `paths` alias or an unknown-project
   * index), so ownership fell back to index order. Counted separately because that is
   * the only part of the dedupe that is arbitrary.
   */
  orderResolvedDuplicates: number;
  /** Per-project indexes that could not be decoded at all — dropped, never silently. */
  undecodable: { scipPath: string; error: string }[];
  /**
   * Indexes that only decoded with UTF-8 validation off (see {@link LoadedScip.lenientUtf8}).
   * Kept — their documents are in the merge — but reported, because a replaced byte sequence
   * inside a SYMBOL string would silently change that symbol's identity.
   */
  lenientUtf8Indexes: { scipPath: string; invalidStrings: number }[];
}

/**
 * One per-project index to merge: its file, plus the repo-relative dir of the project that
 * produced it (`.` for the root project). `project` is what makes ownership deterministic;
 * it is optional because the combined/single-project modes have no per-project identity.
 */
export interface ScipIndexSource {
  scipPath: string;
  project?: string;
}

/**
 * Ownership score of `project` over `path`: the length of the project dir when it is an
 * ancestor of the file, so the LONGEST matching project root wins; -1 when the project does
 * not contain the file (or is unknown). The root project (`.`) scores 0 — it owns a file only
 * when no nested project claims it.
 *
 * Scores the project DIR, whatever made it a project: a pnpm workspace member and a tsconfig-rooted
 * tree discovered outside the workspace globs (`discoverSoloTsconfigProjects`) are equal claimants
 * here, so a discovered project's own files stop falling through to the umbrella root.
 */
export function projectOwnershipScore(project: string | undefined, path: string): number {
  if (project === undefined) return -1;
  if (project === '.' || project === '') return 0;
  const dir = project.replace(/\/+$/, '');
  return path.startsWith(`${dir}/`) ? dir.length : -1;
}

/**
 * Load N `.scip` indexes as ONE index — the per-project workspace mode of `runScipTypescript`
 * writes one index per project instead of one giant index for the whole workspace.
 *
 * Every child runs with cwd=repoRoot, so all indexes share a `projectRoot` and repo-relative
 * document paths; the merge is therefore a concatenation of documents. Two project tsconfigs can
 * both claim a file (overlapping `include`, a composite `references` graph pulling a sibling's
 * source into the program, or a `paths` alias), so documents are deduped by relative path —
 * taking both would double every occurrence in that file.
 *
 * Ownership is by PATH PREFIX, not index order: the claiming project whose dir is the longest
 * ancestor of the file wins (`apps/server/src/x.ts` belongs to `apps/server`'s index, never to a
 * root-level umbrella project that happened to be merged first). Order is only the tiebreak when
 * no claimant contains the file, and that fallback is counted separately
 * (`orderResolvedDuplicates`) so the arbitrary part of the dedupe stays visible. Measured on this
 * repo: every duplicate pair was byte-identical in occurrences, so the policy buys determinism
 * and honest accounting — it does not recover coverage.
 *
 * Metadata (projectRoot) comes from the first index that carries one; they are identical by
 * construction, and an empty one must not blank it out.
 *
 * An index that will not decode is DROPPED and reported in `undecodable`, not thrown: with one
 * index per project, throwing would trade 83 healthy projects for 1 bad one, which is the
 * fail-quiet-vs-fail-total trap this whole change exists to avoid. The single-index path keeps the
 * old strict behaviour — there is nothing to salvage there, so a corrupt index must still be loud.
 *
 * An index that is intact except for invalid UTF-8 in a string is not undecodable: `loadScip`
 * re-decodes it leniently and it is reported in `lenientUtf8Indexes` instead (measured case:
 * posthog's `nodejs` project indexes reproducibly but carries one such string).
 */
export function loadScipIndexes(sources: ScipIndexSource[]): MergedScip {
  if (sources.length === 1) {
    const one = loadScip(sources[0].scipPath);
    return {
      ...one,
      duplicateDocuments: 0,
      orderResolvedDuplicates: 0,
      undecodable: [],
      lenientUtf8Indexes: one.lenientUtf8
        ? [{ scipPath: sources[0].scipPath, invalidStrings: one.lenientUtf8.invalidStrings }]
        : [],
    };
  }
  const documents: LoadedScip['documents'] = [];
  /** Winner so far per relative path: where it sits in `documents` and its ownership score. */
  const winner = new Map<string, { at: number; score: number }>();
  const undecodable: MergedScip['undecodable'] = [];
  const lenientUtf8Indexes: MergedScip['lenientUtf8Indexes'] = [];
  let projectRoot = '';
  let duplicateDocuments = 0;
  /** Paths that were claimed twice and whose winner is owned by no project. */
  const orderResolved = new Set<string>();
  for (const { scipPath, project } of sources) {
    let one: LoadedScip;
    try {
      one = loadScip(scipPath);
    } catch (err) {
      undecodable.push({ scipPath, error: String(err).slice(0, 400) });
      continue;
    }
    if (one.lenientUtf8) lenientUtf8Indexes.push({ scipPath, invalidStrings: one.lenientUtf8.invalidStrings });
    if (!projectRoot && one.projectRoot) projectRoot = one.projectRoot;
    for (const doc of one.documents) {
      const score = projectOwnershipScore(project, doc.relativePath);
      const held = winner.get(doc.relativePath);
      if (!held) {
        winner.set(doc.relativePath, { at: documents.push(doc) - 1, score });
        continue;
      }
      // A duplicate either way — only which copy survives is at stake.
      duplicateDocuments++;
      if (score > held.score) {
        documents[held.at] = doc;
        held.score = score;
      }
      // Nobody contains the file: whichever index came first stays, arbitrarily.
      if (held.score < 0) orderResolved.add(doc.relativePath);
      else orderResolved.delete(doc.relativePath);
    }
  }
  return {
    projectRoot,
    documents,
    duplicateDocuments,
    orderResolvedDuplicates: orderResolved.size,
    undecodable,
    lenientUtf8Indexes,
  };
}

function typedRange(o: TypedRangeOccurrence): number[] {
  if (o.singleLineRange) {
    return [o.singleLineRange.line, o.singleLineRange.startCharacter, o.singleLineRange.endCharacter];
  }
  if (o.multiLineRange) {
    return [
      o.multiLineRange.startLine,
      o.multiLineRange.startCharacter,
      o.multiLineRange.endLine,
      o.multiLineRange.endCharacter,
    ];
  }
  return [0, 0, 0];
}
