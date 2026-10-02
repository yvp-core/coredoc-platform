/**
 * The one skeleton every non-TS language substrate runs through.
 *
 * A language supplies a `Substrate`: its file scope and an `extract` that turns parsed files into
 * facts. Everything the seven substrates used to repeat lives here instead: the `StableIdGenerator`
 * seed (the two-ID invariant), the read/parse-once loop, skipped-file `ParseError`s, the optional
 * SCIP call merge, the WASM tree release on every exit path, the derived stats and the
 * `toParsedRepo` stamp.
 *
 * Tree lifetime: every tree this module parses is alive from its parse until `extract` settles,
 * then freed in a `finally` — a throw anywhere (a lane, the SCIP merge, the parse loop) still
 * frees them. `extract` must therefore await all of its work and return plain data only; a
 * `TsNode` that escapes it is a use-after-free. Trees a lane parses for itself are its own to free.
 */
import { readFileSync } from 'node:fs';
import {
  type AnalysisRecord,
  type CallEdge,
  type CallResolutionStats,
  type ParsedRepo,
  type ParseError,
  StableIdGenerator,
} from '@coredoc/core';
import { mergeScipCallFacts, type ScipCallFile } from '../facts/scip/call-facts.js';
import { type IndexPolicy, type OptionalIndexLanguage, optionalAnalysis } from '../facts/scip/index-host.js';
import { loadOptionalScip, type OptionalScipResult } from '../facts/scip/source-manifest.js';
import type { ParseOptions } from '../providers/types.js';
import { type SupportedLanguage, TreeSitterLoader, type TsNode } from '../tree-sitter/tree-sitter-loader.js';
import { releaseParsedTrees } from '../tree-sitter/tree-release.js';
import type { BaseProfile } from '../types/profile-base.js';
import type { SourceFile } from './file-nodes.js';
import type { SourceFileScope } from './source-file-scope.js';
import { type DraftStats, type ParsedRepoDraft, toParsedRepo } from './to-parsed-repo.js';

/** One in-scope source file with its shared CST root. */
export interface ParsedSource extends SourceFile {
  root: TsNode;
}

/** Tier-B calls in, Tier-B or compiler-enhanced calls out. */
export interface ResolvedCalls {
  calls: CallEdge[];
  stats: CallResolutionStats;
}

export interface SubstrateContext<P, F extends SourceFile> {
  /** Repo root on disk. */
  root: string;
  /** Repo name (`ParseOptions.repoName`). */
  name: string;
  profile: P;
  opts: ParseOptions;
  idGen: StableIdGenerator;
  /** Every in-scope file that was read (and, with a grammar, parsed). */
  files: F[];
  /** In-scope files that could not be read or parsed. Already reported as `ParseError`s. */
  skipped: readonly string[];
  /**
   * Merge the compiler index into Tier-B calls under the profile's analysis policy. Needs
   * `Substrate.scip`; callable once. Records `stats.analysis`. Runs while the trees are alive.
   */
  enhanceCalls(basic: ResolvedCalls): Promise<ResolvedCalls>;
}

/** What `extract` measured. Identity, file counts, timing and `analysis` are owned by the skeleton. */
export type SubstrateFacts = Omit<ParsedRepoDraft, 'id' | 'name' | 'path' | 'parsedAt' | 'parserId' | 'stats'> & {
  stats?: Omit<Partial<DraftStats>, 'totalFiles' | 'parsedFiles' | 'skippedFiles' | 'parseTimeMs'>;
};

export type ScipProfile = BaseProfile & { substrate: { analysis?: IndexPolicy } };

export interface Substrate<P extends ScipProfile, F extends SourceFile = ParsedSource> {
  /** `FileNode.language`, log and `ParseError` label. */
  language: string;
  /** Stamped into the artifact (see `toParsedRepo`). */
  parserVersion: string;
  /** Tree-sitter grammar for the shared parse. Omit to read sources only (no shared trees). */
  grammar?: SupportedLanguage;
  /** The exact source set — the same function the provider's `sourceFiles` exposes to the scorer. */
  scope(profile: P, repoRoot: string): SourceFileScope;
  /** Compiler call index, merged by `ctx.enhanceCalls`. */
  scip?: {
    language: OptionalIndexLanguage;
    run(repoRoot: string, options: { outDir?: string }): Promise<OptionalScipResult>;
    facts(files: F[], idGen: StableIdGenerator): ScipCallFile[];
  };
  extract(ctx: SubstrateContext<P, F>): Promise<SubstrateFacts>;
}

export async function parseSubstrate<P extends ScipProfile, F extends SourceFile>(
  substrate: Substrate<P, F>,
  profile: P,
  opts: ParseOptions,
): Promise<ParsedRepo> {
  const start = Date.now();
  const { repoRoot: root, repoName: name } = opts;
  const idGen = new StableIdGenerator(root, opts.repoKey ?? name);
  const scope = substrate.scope(profile, root);
  const parser = substrate.grammar ? await TreeSitterLoader.getInstance().getParser(substrate.grammar) : undefined;

  const files: F[] = [];
  const skipped: string[] = [];
  let analysis: AnalysisRecord | undefined;
  let facts: SubstrateFacts;
  try {
    for (const relPath of scope.included) {
      try {
        const source = readFileSync(`${root}/${relPath}`, 'utf-8');
        // tree-sitter tolerates syntax errors and utf-8 decode is lenient, so a throw here is an
        // unreadable file or an unexpected parser/WASM failure: the file is skipped, not fatal.
        files.push((parser ? { relPath, source, root: parser.parse(source).rootNode } : { relPath, source }) as F);
      } catch {
        skipped.push(relPath);
      }
    }
    facts = await substrate.extract({
      root,
      name,
      profile,
      opts,
      idGen,
      files,
      skipped,
      async enhanceCalls(basic) {
        const scip = substrate.scip;
        if (!scip) throw new Error(`${substrate.language}: enhanceCalls needs Substrate.scip.`);
        if (analysis) throw new Error(`${substrate.language}: enhanceCalls is callable once.`);
        const enhanced = await optionalAnalysis(
          scip.language,
          files.length ? profile.substrate.analysis : { mode: 'basic' },
          () => scip.run(root, { outDir: opts.scipOutDir ?? opts.cacheDir }),
          (path) => mergeScipCallFacts(loadOptionalScip(path), scip.facts(files, idGen), basic.calls, basic.stats),
        );
        analysis = enhanced.analysis;
        return enhanced.result ?? basic;
      },
    });
  } finally {
    if (parser) releaseParsedTrees(files as unknown as ParsedSource[]);
  }

  // A skipped file is a ParseError, not just a count: the scorecard's silent-failure detector and
  // the CLI's `parseErrors` gauge read `repo.errors`, so a run where every file failed would
  // otherwise score as a clean parse.
  const skippedErrors: ParseError[] = skipped.map((file) => ({
    file,
    message: `${substrate.language}: file could not be read or parsed`,
    severity: 'error',
  }));
  // `parsedFiles` is the emitted FileNode count (the referential-integrity stats check), which
  // can exceed the shared parse: Rust also emits a FileNode per `.sql` schema file it reads.
  const parsedFiles = facts.files?.length ?? files.length;
  return toParsedRepo(
    {
      ...facts,
      id: idGen.getRepoHash(),
      name,
      path: root,
      parsedAt: new Date().toISOString(),
      parserId: profile.parserId,
      errors: [...skippedErrors, ...(facts.errors ?? [])],
      stats: {
        ...facts.stats,
        totalFiles: scope.included.length + Math.max(0, parsedFiles - files.length),
        parsedFiles,
        skippedFiles: skipped.length,
        totalImports: facts.stats?.totalImports ?? facts.imports?.length ?? 0,
        parseTimeMs: Date.now() - start,
        ...(analysis ? { analysis } : {}),
      },
    },
    { parserVersion: substrate.parserVersion },
  );
}
