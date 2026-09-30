/**
 * The one `FileNode` builder every non-TS substrate uses.
 *
 * `FileNode` is a `@coredoc/core` contract, and the Ruby and Python lanes each carried a
 * line-for-line copy of this derivation (same extension slice, same comment-LOC counter, same
 * `contentHash`/`versionedFileId` calls) differing only in the language literal, the line-comment
 * prefix and how the owning package is chosen. A new field on the contract then had to be added
 * twice, and one of the two would eventually be missed.
 */
import type { FileNode, StableIdGenerator } from '@coredoc/core';

/** The minimum a substrate knows about a parsed source file. */
export interface SourceFile {
  relPath: string;
  source: string;
}

export interface FileNodeOptions {
  /** `FileNode.language` for every file of this substrate. */
  language: string;
  /** Line-comment prefix, used to keep comment lines out of `loc` (`#` for Ruby/Python). */
  commentPrefix: string;
  /** Owning package id for one file. A single-package language passes a constant. */
  packageIdFor: (relPath: string) => string;
}

/** Non-blank, non-comment lines — the `loc` every substrate reports. */
function countCodeLines(source: string, commentPrefix: string): number {
  return source.split('\n').filter((line) => {
    const trimmed = line.trim();
    return trimmed.length > 0 && !trimmed.startsWith(commentPrefix);
  }).length;
}

/** One `FileNode` per parsed source. Ids come from the same `idGen` calls every lane references. */
export function toFileNodes(files: SourceFile[], idGen: StableIdGenerator, opts: FileNodeOptions): FileNode[] {
  return files.map((f) => {
    const contentHash = idGen.contentHash(f.source);
    const dot = f.relPath.lastIndexOf('.');
    return {
      id: idGen.fileId(f.relPath),
      versionedId: idGen.versionedFileId(f.relPath, contentHash),
      path: f.relPath,
      extension: dot === -1 ? '' : f.relPath.slice(dot),
      packageId: opts.packageIdFor(f.relPath),
      language: opts.language,
      contentHash,
      loc: countCodeLines(f.source, opts.commentPrefix),
    };
  });
}
