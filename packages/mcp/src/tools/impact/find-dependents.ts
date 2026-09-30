/**
 * find_dependents Tool Handler
 *
 * Find code that depends on a class or interface: subclasses, implementations, and functions that use it as a type.
 */

import { type IGraphReadRepository } from '@coredoc/db';
import { formatCodeElementList, createMetadata } from '../../response-formatter.js';
import { detectAmbiguity, toNodeTypes } from '../../ambiguity.js';
import { debug, debugResult } from '../../debug-logger.js';
import type {
  ScopeContext,
  OutputFormat,
  McpResponse,
  CodeElementInfo,
  CodeElementType,
  DetailLevel,
  DetailLevelConfig,
} from '../../types.js';
import { filterCodeElementArray, resolveDetailLevel } from '../../detail-level.js';
import { typeUsageSummary } from '../../type-usage.js';
import { findTypeByName } from '../../function-name.js';

const USAGE_KIND_TO_ELEMENT_TYPE: Record<string, CodeElementType> = {
  file: 'file',
  function: 'function',
  class: 'class',
  interface: 'interface',
  type_alias: 'type_alias',
  enum: 'enum',
  entrypoint: 'entrypoint',
  entity: 'entity',
  component: 'component',
  route: 'route',
  variable: 'variable',
  state_store: 'state_store',
};

/** The declaration kinds find_dependents can resolve a target to. */
type DependentTypeFilter = 'class' | 'interface' | 'type_alias' | 'enum';

const DEPENDENT_TYPES: readonly DependentTypeFilter[] = ['class', 'interface', 'type_alias', 'enum'];

/**
 * Resolve an omitted `type` from the graph, or explain why the target has no
 * dependents to look for.
 *
 * Returns the kind on success, or `{hint}` when the caller has to be redirected:
 * a function/component target belongs to find_callers (an exported-const React
 * component or hook is a `function` node, so find_dependents genuinely has
 * nothing to resolve), and an unknown name gets the usual not-found.
 */
async function inferDependentType(
  repo: IGraphReadRepository,
  name: string,
  scope: ScopeContext,
): Promise<DependentTypeFilter | { hint: string }> {
  debug('inferDependentType', `name=${name}`);
  const matches = await repo.findCode({ pattern: name, limit: 20 }, scope.repoHashes);
  const exact = matches.filter((m) => m.name === name);
  const typeHit = exact.find((m) => (DEPENDENT_TYPES as readonly string[]).includes(m.type));
  if (typeHit) return typeHit.type as DependentTypeFilter;
  for (const type of DEPENDENT_TYPES)
    if (!exact.length && (await findTypeByName(repo, name, type, scope.repoHashes))) return type;

  const callable = exact.find((m) => m.type === 'function' || m.type === 'component');
  if (callable) {
    return {
      hint:
        `'${name}' is a ${callable.type} (${callable.filePath}:${callable.startLine}), not a type — find_dependents resolves ` +
        `class / interface / type_alias / enum. Use find_callers({functionName: "${name}"}) for its call sites.`,
    };
  }
  return {
    hint: `'${name}' not found in scope as a class, interface, type_alias or enum. Pass \`type\` explicitly, or try search_symbols({pattern: "*${name}*"}).`,
  };
}

/**
 * Handle find_dependents tool
 */
export async function handleFindDependents(
  args: Record<string, unknown>,
  scope: ScopeContext,
  format: OutputFormat,
  detailLevel: DetailLevel,
  detailConfig: DetailLevelConfig,
  repository: IGraphReadRepository,
): Promise<McpResponse<CodeElementInfo[] | string>> {
  // `explain` names its subject `target`, so agents reach for `target` here
  // too. Honor it as an alias rather than resolving `undefined` and reporting
  // "undefined 'undefined' not found in scope" for a name that is in the graph.
  const name = (args.name as string | undefined) ?? (args.target as string | undefined);
  const includeExtensions = args.includeExtensions !== false;

  if (!name) {
    const metadata = await createMetadata(scope, format, detailLevel, detailConfig, repository);
    return {
      data:
        format === 'raw'
          ? []
          : 'find_dependents requires `name` — the class/interface/type_alias/enum to find dependents for (plus `type`).',
      metadata,
    };
  }

  // `type` is advertised as required, but agents omit it constantly. Resolving
  // it from the graph beats a dead end, and it also lets us name find_callers
  // when the target turns out to be a function (React components and hooks
  // exported as consts are functions, not types).
  const requestedType = args.type as DependentTypeFilter | undefined;
  const resolved = requestedType ?? (await inferDependentType(repository, name, scope));
  if (typeof resolved === 'object') {
    const metadata = await createMetadata(scope, format, detailLevel, detailConfig, repository);
    return { data: format === 'raw' ? [] : resolved.hint, metadata };
  }
  const type = resolved;

  debug('getDependents', `name=${name}, type=${type}`);

  const targetId = (await findTypeByName(repository, name, type, scope.repoHashes))?.id ?? null;

  if (!targetId) {
    debugResult('findType', 0);
    const metadata = await createMetadata(scope, format, detailLevel, detailConfig, repository);
    return {
      data: format === 'raw' ? [] : `${type} '${name}' not found in scope`,
      metadata,
    };
  }

  debugResult('findType', 1);

  const dependents: CodeElementInfo[] = [];

  // Get extensions/implementations
  if (includeExtensions) {
    if (type === 'class') {
      debug('getClassExtensions', `classId=${targetId}`);
      const extensions = await repository.getClassExtensions(targetId, scope.repoHashes);
      debugResult('getClassExtensions', extensions.length);
      dependents.push(
        ...extensions.map((c) => ({
          id: c.id,
          name: c.name,
          filePath: c.filePath,
          startLine: c.startLine,
          endLine: c.endLine,
          type: 'class' as const,
        })),
      );
    } else if (type === 'interface') {
      debug('getInterfaceImplementations', `interfaceId=${targetId}`);
      const implementations = await repository.getInterfaceImplementations(targetId, scope.repoHashes);
      debugResult('getInterfaceImplementations', implementations.length);
      dependents.push(
        ...implementations.map((c) => ({
          id: c.id,
          name: c.name,
          filePath: c.filePath,
          startLine: c.startLine,
          endLine: c.endLine,
          type: 'class' as const,
        })),
      );
    }
  }

  // Type-usage consumers: functions whose params/returns name this type,
  // classes whose properties are typed as it, interfaces whose members
  // reference it, type aliases whose right-hand side mentions it, and source
  // Files with a resolved cross-repo package import.
  debug('getTypeUsages', `targetId=${targetId}`);
  const typeUsers = await repository.getTypeUsages(targetId, scope.repoHashes);
  debugResult('getTypeUsages', typeUsers.length);
  const seen = new Set(dependents.map((d) => d.id));
  for (const u of typeUsers) {
    if (seen.has(u.id)) continue;
    seen.add(u.id);
    dependents.push({
      id: u.id,
      name: u.name,
      filePath: u.filePath,
      startLine: u.startLine,
      endLine: u.endLine,
      type: USAGE_KIND_TO_ELEMENT_TYPE[u.type] ?? 'function',
      // A name-matched row may be a DIFFERENT symbol than the one asked about — a
      // trust signal, carried as a STRUCTURED flag (never folded into `name`, which
      // must stay usable for a follow-up `explain`). It survives the basic detail
      // level via filterCodeElementInfo, and the text formatter renders the caveat
      // from it, so the default response never shows a possibly-wrong consumer as proven.
      ...(u.ambiguous && { ambiguous: true }),
      // Tag the usage in the summary so the formatted output explains *how*
      // each consumer touches the type (e.g. "parameter `id`", "return") and,
      // for a value-position row, which enum member it branches on.
      summary: typeUsageSummary(u, name),
    });
  }

  // Filter results based on detail level (use default 'full' config if not provided).
  // `preserveSummary`: find_dependents is basic-by-default and its ONE
  // relationship datum — how each consumer touches the type, including the
  // value-position member it branches on — travels in `summary`. Stripping it
  // would leave the default response listing dependents with no statement of
  // the dependency.
  const config = detailConfig || resolveDetailLevel('full');
  const filteredDependents = filterCodeElementArray(dependents, config, {
    preserveSummary: true,
  }) as CodeElementInfo[];

  const ambiguity = await detectAmbiguity(repository, {
    name,
    scope,
    nodeTypes: toNodeTypes('class', 'interface', 'type_alias', 'enum'),
    resolvedId: targetId,
  });
  const metadata = await createMetadata(scope, format, detailLevel, detailConfig, repository, ambiguity);
  return formatCodeElementList(filteredDependents, `Dependents of ${name}`, metadata);
}
