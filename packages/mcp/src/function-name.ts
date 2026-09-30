/**
 * Function-name parsing shared by tools that look up a function by name.
 *
 * findFunction in @coredoc/db matches the bare `name` column, so a
 * class-qualified input like `MyClass.someMethod` (or `Outer.Inner.method`)
 * never matches. Tools accept the qualified form, parse off the qualifier,
 * and surface it back to the caller for context.
 */
import { NodeType } from '@coredoc/core';
import type { EntityInfo, FunctionInfo, IGraphReadRepository } from '@coredoc/db';

/**
 * Split a possibly-qualified function name like `Class.method` or
 * `Outer.Inner.method` into the bare name used for the DB lookup and the
 * trailing-dropped qualifier (taken as the requested class name).
 *
 * Inputs that look like paths (contain `/`, `\`, or whitespace) or that have
 * a leading/trailing dot are returned unchanged — those are HTTP paths,
 * file paths, or "POST /foo" forms that other tools route differently.
 */
export function parseFunctionName(input: string | undefined): {
  lookupName: string;
  requestedClassName: string | undefined;
} {
  // Guard a missing/non-string arg (callers cast `args.functionName as string`,
  // which lies when the agent passes the wrong key e.g. `symbol`): return an
  // empty lookup so callers emit their normal "not found" instead of crashing
  // on `undefined.lastIndexOf`.
  if (!input || /[/\\\s]/.test(input)) {
    return { lookupName: input ?? '', requestedClassName: undefined };
  }
  // Signature-bearing names are canonical indexed identities (including the
  // declaring type). Splitting them loses overload identity and can split a
  // qualified parameter type instead of the method's owner.
  if (input.includes('(')) return { lookupName: input, requestedClassName: undefined };
  const lastDot = input.lastIndexOf('.');
  if (lastDot <= 0 || lastDot === input.length - 1) {
    return { lookupName: input, requestedClassName: undefined };
  }
  return {
    lookupName: input.slice(lastDot + 1),
    requestedClassName: input.slice(0, lastDot),
  };
}

// Signature-bearing canonical names (C#: `Ns.Type.Method(Args)`) never equal a bare
// `Method` or `Type.Method` input. Anchoring on `.<input>(` + a closing signature keeps
// nested `$lambda` members and same-prefix methods out.
function canonicalMatcher(input: string): RegExp {
  const escaped = input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|\\.)${escaped}\\([^()]*\\)$`);
}

const CANDIDATE_LIMIT = 50;

/**
 * Canonical function names ending in a bare or `Type.method` input, narrowed by `fileHint`.
 * A result that fills the limit cannot prove uniqueness, so callers treat it as ambiguous.
 */
export async function canonicalFunctionCandidates(
  repository: IGraphReadRepository,
  input: string,
  repoHashes: string[],
  fileHint?: string,
): Promise<{ names: string[]; filePaths: string[]; truncated: boolean }> {
  if (!input || input.includes('(') || /[/\\\s]/.test(input)) return { names: [], filePaths: [], truncated: false };
  const matcher = canonicalMatcher(input);
  let candidates = await repository.findCode(
    { pattern: `*.${input}(*`, types: [NodeType.Function], limit: CANDIDATE_LIMIT },
    repoHashes,
  );
  let truncated = candidates.length >= CANDIDATE_LIMIT;
  // findCode cannot filter by path, so a full window may omit the hinted file entirely;
  // that file's own symbols are the complete candidate set.
  if (truncated && fileHint) {
    const inFile = (await repository.listSymbolsInFile(fileHint, repoHashes)).filter(
      (symbol) => symbol.type === NodeType.Function,
    );
    if (inFile.length) {
      candidates = inFile;
      truncated = false;
    }
  }
  const matches = candidates.filter(
    (candidate) => matcher.test(candidate.name) && (!fileHint || candidate.filePath?.includes(fileHint)),
  );
  return {
    names: matches.map((match) => match.name),
    filePaths: matches.map((match) => match.filePath ?? ''),
    truncated,
  };
}

/**
 * findFunction for tool inputs: exact name first (with `Class.method` split off), then the
 * canonical signature-bearing name that ends in the input — only when exactly one does, so
 * overloads or same-named methods on other types are reported, never picked arbitrarily.
 */
export async function findFunctionByName(
  repository: IGraphReadRepository,
  input: string,
  repoHashes: string[],
  fileHint?: string,
): Promise<FunctionInfo | null> {
  const { lookupName, requestedClassName } = parseFunctionName(input);
  const exact = await repository.findFunction(lookupName, repoHashes, fileHint, requestedClassName);
  if (exact) return exact;
  const { names, filePaths, truncated } = await canonicalFunctionCandidates(repository, input, repoHashes, fileHint);
  return names.length === 1 && !truncated ? repository.findFunction(names[0]!, repoHashes, filePaths[0]) : null;
}

/** "`X` is ambiguous" line for a not-found response, or undefined when the name matched nothing. */
export async function ambiguousFunctionNote(
  repository: IGraphReadRepository,
  input: string,
  repoHashes: string[],
  fileHint?: string,
): Promise<string | undefined> {
  const { names, truncated } = await canonicalFunctionCandidates(repository, input, repoHashes, fileHint);
  if (names.length < 2 && !truncated) return undefined;
  const listed = names
    .slice(0, 10)
    .map((name) => `\`${name}\``)
    .join(', ');
  return `'${input}' matches ${truncated ? 'many' : names.length} functions (${listed}${names.length > 10 || truncated ? ', …' : ''}). Pass the full signature${fileHint ? ' or `Type.method`' : ', `Type.method`, or a fileHint'}.`;
}

/** findEntity for tool inputs: entity name or table name, then a unique namespace-qualified name ending in it. */
export async function findEntityByName(
  repository: IGraphReadRepository,
  input: string,
  repoHashes: string[],
): Promise<EntityInfo | null> {
  const exact = await repository.findEntity(input, repoHashes);
  if (exact || !input) return exact;
  const matches = (await repository.listEntities(repoHashes)).filter((entity) => entity.name.endsWith(`.${input}`));
  return matches.length === 1 ? matches[0]! : null;
}

type TypeKind = 'class' | 'interface' | 'type_alias' | 'enum';
export interface ResolvedType {
  id: string;
  name: string;
  filePath: string;
  startLine: number;
  endLine?: number;
}

/**
 * Resolve a class / interface / type alias / enum by name. Exact name first; with
 * `qualified`, also a namespace-qualified declaration (C#: `Ns.Type`, generic `Ns.Type\`1`)
 * ending in the input — only when exactly one does, so a short name never picks arbitrarily.
 */
export async function findTypeByName(
  repository: IGraphReadRepository,
  input: string,
  type: TypeKind,
  repoHashes: string[],
  qualified = true,
): Promise<ResolvedType | null> {
  const exact =
    type === 'class'
      ? await repository.findClass(input, repoHashes)
      : type === 'interface'
        ? await repository.findInterface(input, repoHashes)
        : (await repository.findCode({ pattern: input, types: [type as NodeType], limit: 1 }, repoHashes)).find(
            (match) => match.name === input,
          );
  if (exact || !qualified || !input || /[\s/\\(]/.test(input)) return exact ?? null;
  const escaped = input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matcher = new RegExp(`(^|\\.)${escaped}(\`\\d+)?$`);
  // Suffix queries (plain, then generic arity) keep the window to same-named declarations;
  // a query that fills it cannot prove the match is unique.
  const matches = new Map<string, ResolvedType>();
  for (const pattern of [`*.${input}`, `*.${input}\`*`]) {
    const candidates = await repository.findCode(
      { pattern, types: [type as NodeType], limit: CANDIDATE_LIMIT },
      repoHashes,
    );
    if (candidates.length >= CANDIDATE_LIMIT) return null;
    for (const candidate of candidates)
      if (matcher.test(candidate.name)) matches.set(candidate.id, candidate as ResolvedType);
  }
  return matches.size === 1 ? [...matches.values()][0]! : null;
}

/**
 * Interface methods that `fn` implements, for canonical signature-bearing names
 * (`Ns.Type.Method(Args)`): callers bound to `ICrudService\`1.DeleteAsync(T,…)` reach
 * `CrudService\`1.DeleteAsync(T,…)` through dispatch the call graph cannot see.
 */
// ponytail: matches identical signature text only; a closed generic (`: ICrud<Product>`) whose
// parameters read `Product` instead of `T` is missed until implements edges carry member maps.
export async function implementedInterfaceMethods(
  repository: IGraphReadRepository,
  fn: FunctionInfo,
  repoHashes: string[],
): Promise<string[]> {
  const owner = fn.className;
  if (!owner || !fn.name.includes('(') || !fn.name.startsWith(`${owner}.`)) return [];
  const member = fn.name.slice(owner.length + 1);
  const candidates = await repository.findCode(
    { pattern: `*.${member}`, types: [NodeType.Function], limit: 50 },
    repoHashes,
  );
  const ids: string[] = [];
  for (const candidate of candidates) {
    if (candidate.id === fn.id || !candidate.name.endsWith(`.${member}`)) continue;
    const iface = await repository.findInterface(candidate.name.slice(0, -member.length - 1), repoHashes);
    if (!iface) continue;
    const implementors = await repository.getInterfaceImplementations(iface.id, repoHashes);
    if (implementors.some((implementor) => implementor.name === owner)) ids.push(candidate.id);
  }
  return ids;
}
