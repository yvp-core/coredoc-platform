/**
 * The shared node builders every non-TS substrate uses: `FileNode`s, synthesized db-op performer
 * `FunctionNode`s and http `Entrypoint`s.
 *
 * `FileNode` is a `@coredoc/core` contract, and the Ruby and Python lanes each carried a
 * line-for-line copy of this derivation (same extension slice, same comment-LOC counter, same
 * `contentHash`/`versionedFileId` calls) differing only in the language literal, the line-comment
 * prefix and how the owning package is chosen. A new field on the contract then had to be added
 * twice, and one of the two would eventually be missed.
 */
import type { Entrypoint, FileNode, FunctionNode, HttpMethod, StableIdGenerator } from '@coredoc/core';

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

/** A synthesized minimal-valid `FunctionNode` for an enclosing def — the performer of its db-ops. */
export function makeFunctionNode(
  idGen: StableIdGenerator,
  id: string,
  name: string,
  kind: FunctionNode['kind'],
  relPath: string,
  line: number,
): FunctionNode {
  return {
    id,
    versionedId: idGen.versionedId(id, `${name}@${relPath}:${line}`),
    name,
    kind,
    fileId: idGen.fileId(relPath),
    location: { filePath: relPath, startLine: line, endLine: line },
    isAsync: false,
    isGenerator: false,
    parameters: [],
  };
}

/**
 * One http entrypoint. Without a resolvable `handlerId` it falls back to the documented synthetic
 * id — a function id whose name segment is `"<METHOD> <path>"` — which the referential-integrity
 * validator treats as a non-violating exception, so its SHAPE must stay stable.
 */
export function httpEntrypoint(
  idGen: StableIdGenerator,
  method: HttpMethod,
  fullPath: string,
  relPath: string,
  startLine: number,
  endLine: number,
  handlerId?: string,
): Entrypoint {
  const id = idGen.httpEntrypointId(method, fullPath, relPath);
  return {
    id,
    versionedId: idGen.versionedId(id, `${method} ${fullPath}`),
    type: 'http',
    handlerId: handlerId ?? idGen.functionId(relPath, `${method} ${fullPath}`),
    location: { filePath: relPath, startLine, endLine },
    details: { type: 'http', method, path: fullPath, fullPath },
  };
}
