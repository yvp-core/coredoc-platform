/**
 * Ruby STRUCTURE nodes — `Package` and `FileNode`.
 *
 * The Ruby substrate used to emit neither, so every FunctionNode's `fileId` and every
 * EntityNode's `fileId` pointed at a node nobody emitted: file→symbol joins returned nothing
 * for the whole repository while the parse still self-reported clean. Ids are minted with the
 * SAME `StableIdGenerator` calls those references already use (`fileId(relPath)`,
 * `packageId(dir)`), so the joins hold by construction.
 *
 * PACKAGES: a Ruby application is one distribution — there is no per-directory package
 * concept to mirror (no `go.mod` tree, no `pyproject.toml` tree). The repo root is emitted as
 * the single owner every FileNode joins to. Like the Python root package it carries NO
 * `language`: it is the fallback owner every target shares, and the multi-target merge
 * attributes its language from the merged files.
 */
import type { FileNode, Package, StableIdGenerator } from '@coredoc/core';
import { type SourceFile, toFileNodes } from '../file-nodes.js';

/** The repo-root path used as the single package owner. */
const ROOT_PACKAGE_PATH = '.';

/** The one package a Ruby repo has: its root. */
export function toRubyPackages(repoName: string, idGen: StableIdGenerator): Package[] {
  return [{ id: idGen.packageId(ROOT_PACKAGE_PATH), name: repoName, path: ROOT_PACKAGE_PATH }];
}

/** One `FileNode` per parsed Ruby source, owned by the root package (Ruby has only that one). */
export function toRubyFileNodes(files: SourceFile[], idGen: StableIdGenerator): FileNode[] {
  const packageId = idGen.packageId(ROOT_PACKAGE_PATH);
  return toFileNodes(files, idGen, { language: 'ruby', commentPrefix: '#', packageIdFor: () => packageId });
}
