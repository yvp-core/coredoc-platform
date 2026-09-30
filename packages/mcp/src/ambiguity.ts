/**
 * Shared by-name ambiguity detection.
 *
 * Several tools resolve a target by name and take the first match (`findFunction`
 * / `findClass` / … all `LIMIT 1`). When a name collides — e.g. `createCompany`
 * exists as both a controller method and a service method — that silently hides
 * the alternatives. This helper re-runs the exact-name lookup via `findCode`
 * (cheap, indexed, both backends) and, when more than one symbol matches,
 * produces an `AmbiguityInfo` the tool attaches to its response metadata. The
 * tool still returns full data for the first match; the hint just tells the
 * agent how many more exist and how to target them (`fileHint` / `className`).
 */

import type { IGraphReadRepository } from '@coredoc/db';
import { NodeType } from '@coredoc/core';
import type { AmbiguityInfo, ScopeContext } from './types.js';
import { resolveRepoName } from './response-formatter.js';

/**
 * Coerce element-type strings (CodeElementType / NodeType string values are
 * identical — both are the lowercase graph type) into NodeType enum members,
 * dropping any that don't map. Lets tools that only hold a string type build the
 * `nodeTypes` filter without a local switch.
 */
export function toNodeTypes(...types: string[]): NodeType[] {
  const valid = new Set<string>(Object.values(NodeType));
  return types.filter((t) => valid.has(t)) as NodeType[];
}

/** How many alternatives to list before collapsing the rest into "+N more". */
const SHOWN_LIMIT = 5;
/** `findCode` cap — also the threshold above which we report the count as "N+". */
const MATCH_LIMIT = 50;

export interface DetectAmbiguityParams {
  /** The exact name that was looked up (the bare symbol, not "Class.method"). */
  name: string;
  scope: ScopeContext;
  /** Node kinds the resolving tool considered (e.g. [Function], [Class, Interface]). */
  nodeTypes: NodeType[];
  /** The id of the symbol the tool actually resolved and is returning data for. */
  resolvedId: string;
  /**
   * Path of the resolved symbol, shown in the hint. Optional — when omitted it
   * is derived from the matched candidate, so callers holding only the id don't
   * have to thread the path through.
   */
  resolvedFilePath?: string;
  /** A `fileHint` the caller passed, if any — narrows the candidate set too. */
  fileHint?: string;
  /**
   * A class qualifier the caller passed (from a `Class.method` input). When set,
   * the candidate set is filtered to methods of that class, so an explicit
   * disambiguation suppresses the "N more matches" banner instead of counting
   * same-named methods in other classes.
   */
  className?: string;
  /** Whether the calling tool accepts a `className` param (methods do). */
  supportsClassName?: boolean;
}

/**
 * Returns an `AmbiguityInfo` when the name matched more than one symbol in
 * scope, otherwise `undefined`. Never throws — ambiguity hints are advisory, so
 * a lookup failure simply yields no hint rather than breaking the tool.
 */
export async function detectAmbiguity(
  repo: IGraphReadRepository,
  params: DetectAmbiguityParams,
): Promise<AmbiguityInfo | undefined> {
  const { name, scope, nodeTypes, resolvedId, resolvedFilePath, fileHint, className, supportsClassName } = params;

  let matches: Awaited<ReturnType<IGraphReadRepository['findCode']>>;
  try {
    // No-wildcard pattern → exact equality in both backends. `findCode` may
    // still substring-collide on other rows in theory, so we filter to exact
    // name below to be safe.
    matches = await repo.findCode({ pattern: name, types: nodeTypes, limit: MATCH_LIMIT }, scope.repoHashes);
  } catch {
    return undefined;
  }

  const lowerHint = fileHint?.toLowerCase();
  // When a class qualifier was given, keep only methods of that class. Node ids
  // end with `<Class>.<method>` for methods (`<name>` for free functions), so
  // the trailing colon-segment starting with `<Class>.` identifies the class.
  const classPrefix = className ? `${className.toLowerCase()}.` : undefined;
  const seen = new Set<string>();
  const exact = matches.filter((m) => {
    if (m.name !== name) return false;
    if (lowerHint && !m.filePath.toLowerCase().includes(lowerHint)) return false;
    if (classPrefix) {
      const tail = (m.id.split(':').pop() ?? '').toLowerCase();
      if (!tail.startsWith(classPrefix)) return false;
    }
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });

  if (exact.length <= 1) return undefined;

  const others = exact.filter((m) => m.id !== resolvedId);
  if (others.length === 0) return undefined;

  const shown = others.slice(0, SHOWN_LIMIT);
  const moreCount = others.length - shown.length;

  const resolvedPath = resolvedFilePath ?? exact.find((m) => m.id === resolvedId)?.filePath ?? 'the first match';
  // Same ` [repo: X]` tag the list formatters use, and for the same reason: in a
  // multi-repo scope a bare `path:line` alternative is unattributable, and the
  // paths of same-named declarations in sibling repos often look identical.
  const list = shown
    .map((m) => {
      const repoName = resolveRepoName(scope, m.id);
      return `${m.filePath}:${m.startLine}${repoName ? ` [repo: ${repoName}]` : ''}`;
    })
    .join(', ');
  const more = moreCount > 0 ? ` (+${moreCount} more)` : '';
  const disambiguators = supportsClassName ? '`fileHint` (path) or `className` (for methods)' : '`fileHint` (path)';
  const countLabel = exact.length >= MATCH_LIMIT ? `${MATCH_LIMIT}+` : String(exact.length);
  const hint =
    `"${name}" matched ${countLabel} symbols in scope — returning ${resolvedPath}. ` +
    `Other matches: ${list}${more}. Re-call with ${disambiguators} to target a different one.`;

  return {
    totalMatches: exact.length,
    others: shown.map((m) => ({
      name: m.name,
      type: m.type,
      filePath: m.filePath,
      startLine: m.startLine,
      ...(resolveRepoName(scope, m.id) ? { repo: resolveRepoName(scope, m.id) } : {}),
    })),
    moreCount,
    hint,
  };
}
