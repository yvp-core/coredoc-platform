/**
 * BR-16 — the post-imports classification of the `const`/`var` candidates the declaration walk
 * collected: every one of them is either a TYPE ALIAS or a plain VARIABLE, and nothing else.
 *
 * The split is a question about the VALUE, not about the keyword: `const` is how Zig writes both
 * `pub const VERSION = "1.0"` and `pub const Error = error{ Oops }`. A value names a type when it
 * is `@This()`, an `error{…}` set, or a name chain that resolves — by the same `zig-type` /
 * `zig-import` rules the call graph uses — to a container or enum this parse actually emitted.
 * Anything else is a value, so it is a `VariableNode` with its annotation and initializer text.
 *
 * This runs AFTER the import tables exist, because `const In = other.Inner` is only decidable
 * once `other` has a target file (BR-16); a binding that is ONLY an import emits neither node —
 * its `ImportEdge` already is that statement.
 */
import type { StableIdGenerator, TypeAliasNode, VariableNode } from '@coredoc/core';
import { containerInFile } from './zig-callgraph.js';
import { ERROR_SET_DECL, docComment, memberChain } from './zig-cst.js';
import type { ZigConstantCandidate, ZigFileEntry, ZigFileFacts } from './zig-declarations.js';
import { type ZigImportIndex, resolveBinding } from './zig-imports.js';

export interface ZigConstants {
  variables: VariableNode[];
  typeAliases: TypeAliasNode[];
}

/** Whether a qualified name is an emitted container or enum of `facts`. */
function namesType(facts: ZigFileFacts, qualified: string): boolean {
  return facts.index.containers.has(qualified) || facts.decls.enums.some((e) => e.name === qualified);
}

/** The same name, and the same name qualified by the file-struct (BR-4 qualifies both ways). */
function namesTypeEitherWay(facts: ZigFileFacts, qualified: string): boolean {
  const fileStruct = facts.index.fileStruct?.name;
  return namesType(facts, qualified) || (fileStruct !== undefined && namesType(facts, `${fileStruct}.${qualified}`));
}

/** `T`, `Outer.Inner`, `other.Inner` → does it name an emitted type here or in the import target? */
function resolvesToType(
  chain: string[],
  facts: ZigFileFacts,
  relPath: string,
  index: ZigImportIndex,
  byPath: Map<string, ZigFileFacts>,
): boolean {
  // Same RT2 shadow rule the call tiers use: a file-struct basename that is ALSO an `@import`
  // binding in its own file means the import.
  const base = containerInFile(facts, chain[0], new Set(index.byFile.get(relPath)?.keys() ?? []));
  const local = base ? [base, ...chain.slice(1)].join('.') : chain.join('.');
  if (namesTypeEitherWay(facts, local)) return true;

  const binding = resolveBinding(index, relPath, chain[0]);
  const target = binding ? byPath.get(binding.targetRelPath) : undefined;
  if (!target) return false;
  const rest = [...(binding?.members ?? []), ...chain.slice(1)];
  // A bare namespace binding (`const other = @import("o.zig")`) names a FILE, not a type.
  return rest.length > 0 && namesTypeEitherWay(target, rest.join('.'));
}

function isTypeAlias(
  candidate: ZigConstantCandidate,
  facts: ZigFileFacts,
  relPath: string,
  index: ZigImportIndex,
  byPath: Map<string, ZigFileFacts>,
): boolean {
  if (candidate.valueNode.type === ERROR_SET_DECL) return true;
  const chain = memberChain(candidate.valueNode);
  if (!chain) return false;
  // `@This()` is the enclosing container itself — an alias by construction, with no chain to walk.
  if (chain[0] === '@This()') return chain.length === 1;
  return resolvesToType(chain, facts, relPath, index, byPath);
}

/** Split every candidate into `variables` / `typeAliases` (BR-16). First declaration of an id wins. */
export function classifyZigConstants(
  files: ReadonlyArray<ZigFileEntry>,
  index: ZigImportIndex,
  idGen: StableIdGenerator,
): ZigConstants {
  const byPath = new Map(files.map((f) => [f.relPath, f.facts]));
  const out: ZigConstants = { variables: [], typeAliases: [] };
  const claimed = new Set<string>();

  for (const { relPath, facts } of files) {
    const fileId = idGen.fileId(relPath);
    for (const candidate of facts.constantCandidates) {
      const alias = isTypeAlias(candidate, facts, relPath, index, byPath);
      const id = alias
        ? idGen.typeAliasId(relPath, candidate.qualifiedName)
        : idGen.variableId(relPath, candidate.qualifiedName);
      if (claimed.has(id)) continue;
      claimed.add(id);

      const documentation = docComment(candidate.node);
      const base = {
        id,
        versionedId: idGen.versionedId(id, candidate.node.text as string),
        name: candidate.qualifiedName,
        location: candidate.location,
        fileId,
        isExported: candidate.isPub,
        ...(documentation !== undefined ? { documentation } : {}),
      };

      if (alias) {
        out.typeAliases.push({ ...base, kind: 'type-alias', aliasedType: { text: candidate.valueText } });
      } else {
        out.variables.push({
          ...base,
          kind: 'variable',
          declarationKind: candidate.declarationKind,
          ...(candidate.typeText !== undefined ? { type: { text: candidate.typeText } } : {}),
          initialValue: candidate.valueText,
        });
      }
    }
  }
  return out;
}
