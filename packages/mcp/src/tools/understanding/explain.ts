/**
 * explain Tool Handler — node-type-agnostic router.
 *
 * Agents type a name (`BookingService.createBooking`, `Calculator`, `DailySummary`)
 * or a path (`POST /v1/foo`) and let `explain` figure out the kind. Routes
 * functions/methods to `explain_function`, HTTP-shaped targets to
 * `explain_entrypoint`, ENTITIES (incl. ORM class+entity models) to
 * `describe_db_schema` (byte-identical schema block, one source of truth), and
 * inlines the structure for the rest: enum values, interface members, class
 * properties, type-alias definitions — with navigation tools demoted to a
 * one-line "Deeper:" footer. Exact-name match by default; substring fuzzy
 * fallback only on miss.
 *
 * The router exists because agents otherwise call `explain_function` on
 * classes / interfaces / types that the parser tracks as different node
 * kinds, wasting many MCP calls per cross-repo trace.
 */

import {
  type IGraphReadRepository,
  type CodeElement,
  type ClassPropertyInfo,
  type InterfaceMemberInfo,
} from '@coredoc/db';
// NodeType/EdgeType enums (runtime values) — imported from @coredoc/core
// (canonical source) so they survive `vi.mock('@coredoc/db')` in tests.
import { EdgeType, NodeType } from '@coredoc/core';
import { allowSourcesInGraph } from '@coredoc/core/utils';
import { entrypointAddressTokens } from '../../entrypoint-address.js';
import { enumValuesList } from '../../entity-enums.js';
import { resolveDetailLevel } from '../../detail-level.js';
import { handleExplainFunction } from './explain-function.js';
import { handleExplainEntrypoint } from './explain-entrypoint.js';
import { handleDescribeDbSchema } from '../discovery/describe-db-schema.js';
import { handleListFileSymbols } from '../discovery/list-file-symbols.js';
import { formatExplain, createMetadata, resolveRepoName } from '../../response-formatter.js';
import { declaredElsewhereLine } from '../../empty-results.js';
import { crossRepoLookupHashes } from '../../scope-resolver.js';
import { debug, debugResult } from '../../debug-logger.js';
import { parseFunctionName } from '../../function-name.js';
import { dedupeByKinds } from '../../dedupe-kinds.js';
import { memberValueUsageNote } from '../../type-usage.js';
import { HTTP_METHOD_ALTERNATION } from '../../http-method.js';
import type {
  ScopeContext,
  OutputFormat,
  McpResponse,
  ExplainResult,
  ExplainCandidate,
  ExplainMetadata,
  CodeElementType,
  DetailLevel,
  DetailLevelConfig,
} from '../../types.js';

// Node kinds we explicitly know how to surface as metadata. Function and
// entrypoint are excluded because they get dispatched to dedicated handlers
// before metadata rendering ever runs.
const METADATA_KINDS = new Set<CodeElementType>([
  'class',
  'interface',
  'type_alias',
  'enum',
  'entity',
  'component',
  'variable',
  'route',
]);

// All name-addressable kinds we want `explain` to recognize. `findCode`
// defaults exclude type_alias/enum/component/variable/route — agents
// reaching for `explain` expect those to resolve as readily as classes.
//
// Entrypoints are deliberately omitted: the parser stores their full node id
// (e.g. `<hash>:entrypoint:src/foo.ts:http:GET:/api/foo`) as the `name`
// column, so a substring search on a short bare word like `Calc` floods
// fuzzy results with every URL containing that word. Entrypoints are
// reached via the HTTP-path branch above, which uses path/method addressing.
const NAME_ADDRESSABLE_KINDS: NodeType[] = [
  NodeType.Function,
  NodeType.Class,
  NodeType.Interface,
  NodeType.TypeAlias,
  NodeType.Enum,
  NodeType.Entity,
  NodeType.Component,
  NodeType.Variable,
  NodeType.Route,
];

// Detects "POST /path", "/path", "GET /api/foo", "ALL /api/foo" — agent intent:
// this is an HTTP entrypoint, not a symbol name. Method is optional; the bare
// slash prefix is enough to route. Anchored regex keeps "/Class" (illegal name
// anyway) from masquerading as a path. The verb list includes the ALL/ANY
// wildcards, which is how file-convention (Pages API) routes are stored and
// therefore how `list_entrypoints` prints them back to the agent.
const HTTP_PATH_PATTERN = new RegExp(`^(?:(?:${HTTP_METHOD_ALTERNATION})\\s+)?/[A-Za-z0-9_/{}.\\-:]*$`, 'i');

export function looksLikeHttpPath(target: string): boolean {
  return HTTP_PATH_PATTERN.test(target.trim());
}

// Detects a file-location target like `src/foo.ts:42` or `a/b/Bar.tsx:120`.
// Requires a dotted file segment before the line so it never collides with
// `Class.method` (no slash, no trailing `:NN`) or `POST /path` (HTTP branch
// runs first anyway). The path part may itself contain no spaces.
const PATH_LINE_PATTERN = /^(\S*[^\s:]\.[A-Za-z0-9]+):(\d+)$/;

function parsePathLine(target: string): { filePath: string; line: number } | null {
  const m = PATH_LINE_PATTERN.exec(target.trim());
  if (!m) return null;
  const line = Number(m[2]);
  if (!Number.isFinite(line) || line < 1) return null;
  return { filePath: m[1]!, line };
}

// Extensions the parser can produce nodes for. Used only to tell a FILE PATH
// apart from a dotted symbol name, so it needs to cover the languages the
// substrate parses, not every file on disk.
const SOURCE_EXTENSIONS = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'mts',
  'cts',
  'py',
  'rb',
  'go',
  'rs',
  'zig',
  'java',
  'kt',
  'cs',
  'php',
  'swift',
  'scala',
  'c',
  'h',
  'cc',
  'cpp',
  'hpp',
  'sql',
  'graphql',
  'gql',
  'vue',
  'svelte',
]);

// Detects a bare file-path target (`apps/studio/pages/.../users.tsx`). The tool
// description advertises `path:line`, and agents reasonably drop the line when
// they want "what's in this file?" — without this branch those targets fell
// into the symbol lookup and dead-ended on not-found.
//
// A directory separator is REQUIRED: a bare `users.tsx` is indistinguishable
// from a dotted symbol name (`Foo.bar`), and the symbol path is the safer read
// for that shape. `path:line` is excluded because it has its own branch, and
// HTTP-shaped targets never reach here (the HTTP branch runs first).
const FILE_PATH_PATTERN = /^(?=[^\s]*\/)[^\s:]+\.([A-Za-z0-9]+)$/;

export function looksLikeFilePath(target: string): boolean {
  const m = FILE_PATH_PATTERN.exec(target.trim());
  if (!m) return false;
  return SOURCE_EXTENSIONS.has(m[1]!.toLowerCase());
}

/**
 * Pick the symbol whose [startLine, endLine] range encloses `line`, preferring
 * the innermost (smallest) range so a method wins over its containing class.
 * Falls back to the nearest declaration starting at or before the line when no
 * range strictly encloses it (parser may not record endLine for every kind).
 */
function pickSymbolAtLine(rows: CodeElement[], line: number): CodeElement | null {
  const enclosing = rows.filter((r) => r.startLine <= line && (r.endLine ?? r.startLine) >= line);
  if (enclosing.length > 0) {
    return [...enclosing].sort((a, b) => {
      const aSpan = (a.endLine ?? a.startLine) - a.startLine;
      const bSpan = (b.endLine ?? b.startLine) - b.startLine;
      return aSpan - bSpan;
    })[0]!;
  }
  const atOrBefore = rows.filter((r) => r.startLine <= line).sort((a, b) => b.startLine - a.startLine);
  return atOrBefore[0] ?? null;
}

/** Bare last segment for collision-tolerant matching (`Foo.bar` → `bar`). */
function bareName(s: string): string {
  const i = s.lastIndexOf('.');
  return i < 0 ? s : s.slice(i + 1);
}

/**
 * Collapse parser-derived duplicates that share `(name, file, start_line)` to the
 * precedence winner, discarding the per-location kinds list. For `explain` the
 * multi-kind pairs (function+component, class+entity) are all one thing — the
 * agent wants the richer node and ends up needing both follow-ups anyway. The
 * winner rule lives in dedupeByKinds, shared with search_symbols so the two tools
 * never disagree on which kind wins.
 */
function dedupeParserDuplicates(candidates: CodeElement[]): CodeElement[] {
  return dedupeByKinds(candidates).map((m) => m.element);
}

function toCandidate(el: CodeElement, scope: ScopeContext, className?: string): ExplainCandidate {
  const repo = resolveRepoName(scope, el.id);
  return {
    name: el.name,
    kind: (el.type as CodeElementType) ?? 'unknown',
    filePath: el.filePath,
    startLine: el.startLine,
    ...(el.endLine !== undefined && { endLine: el.endLine }),
    ...(el.summary && { summary: el.summary }),
    ...(className && { className }),
    ...(repo && { repo }),
  };
}

// Cap the inline field preview at default detail so `explain` on a wide
// interface/class stays compact; an explicit detailLevel:'full' passes
// Infinity to expand (the dispatcher resolves an omitted detailLevel to
// 'basic' for explain — see getDefaultDetailLevel).
const MAX_FIELD_PREVIEW = 40;

function applyFieldsPreview(
  meta: ExplainMetadata,
  lines: string[],
  label: string,
  limit: number = MAX_FIELD_PREVIEW,
): void {
  if (lines.length === 0) return;
  meta.fieldsLabel = label;
  meta.fieldsTotal = lines.length;
  meta.fields = lines.slice(0, limit);
}

function applyMethodsPreview(meta: ExplainMetadata, lines: string[], limit: number): void {
  if (lines.length === 0) return;
  meta.methodsTotal = lines.length;
  meta.methods = lines.slice(0, limit);
}

/** Cap on the precise HAS_METHOD expansion (the read API clamps at 200). */
const MAX_CLASS_METHOD_NEIGHBORS = 200;

/** One method row reduced to what the preview needs: a name and a sort key. */
interface MethodRow {
  name: string;
  startLine: number;
}

/**
 * Precise method containment: the class's own outgoing HAS_METHOD edges, which
 * the parser emits per declared method. Empty for graphs pushed before those
 * edges existed — the caller then falls back to the line-range read.
 */
async function hasMethodRows(el: CodeElement, repo: IGraphReadRepository, scope: ScopeContext): Promise<MethodRow[]> {
  const { nodes } = await repo.getNeighbors(
    el.id,
    { direction: 'out', edgeTypes: [EdgeType.HasMethod], limit: MAX_CLASS_METHOD_NEIGHBORS },
    scope.repoHashes,
  );
  return nodes.filter((n) => n.type === NodeType.Function).map((n) => ({ name: n.name, startLine: n.startLine ?? 0 }));
}

/**
 * Fallback containment for graphs with no HAS_METHOD edges: the file's symbol
 * listing filtered to the class's line range (or, for graphs that recorded no
 * `endLine` on the class, to node ids carrying the `<Class>.<method>` tail the
 * parser writes for methods).
 *
 * Approximate by construction — a helper function DECLARED INSIDE a method body
 * is also inside the class range, so it can leak into the list. That is why
 * this runs only when the precise channel returns nothing.
 */
async function rangeMethodRows(el: CodeElement, repo: IGraphReadRepository, scope: ScopeContext): Promise<MethodRow[]> {
  const rows = await repo.listSymbolsInFile(el.filePath, scope.repoHashes);
  const endLine = el.endLine;
  const idTailPrefix = `${el.name.toLowerCase()}.`;
  const methods: MethodRow[] = [];
  for (const row of rows) {
    if (row.type !== NodeType.Function || row.id === el.id) continue;
    const withinRange = endLine !== undefined && row.startLine >= el.startLine && row.startLine <= endLine;
    const tail = (row.id.split(':').pop() ?? '').toLowerCase();
    if (!withinRange && !tail.startsWith(idTailPrefix)) continue;
    methods.push({ name: row.name, startLine: row.startLine });
  }
  return methods;
}

/**
 * The methods a class CONTAINS. Methods are FUNCTION nodes, not
 * `ClassInfo.properties`, which is why a class explanation used to come back as
 * a property list.
 *
 * Source ORDER matters: the precise HAS_METHOD containment the parser emits
 * comes FIRST, and the approximate line-range read is used ONLY as a fallback
 * when that returns nothing (older graphs pushed without those edges).
 */
async function classMethodLines(el: CodeElement, repo: IGraphReadRepository, scope: ScopeContext): Promise<string[]> {
  const precise = await hasMethodRows(el, repo, scope);
  const rows = precise.length > 0 ? precise : await rangeMethodRows(el, repo, scope);
  const seen = new Set<string>();
  const unique: MethodRow[] = [];
  for (const row of rows) {
    const name = bareName(row.name);
    if (seen.has(name)) continue;
    seen.add(name);
    unique.push(row);
  }
  return unique.sort((a, b) => a.startLine - b.startLine).map((m) => `${bareName(m.name)}()`);
}

function renderClassProperty(p: ClassPropertyInfo): string {
  const flags: string[] = [];
  if (p.isReadonly) flags.push('readonly');
  if (p.isOptional) flags.push('optional');
  if (p.isStatic) flags.push('static');
  const type = p.typeText ? `: ${p.typeText}` : '';
  return `${p.name}${type}${flags.length ? ` [${flags.join(', ')}]` : ''}`;
}

function renderInterfaceMember(m: InterfaceMemberInfo): string {
  if (m.kind === 'method') {
    return `${m.name}()${m.returnTypeText ? `: ${m.returnTypeText}` : ''}`;
  }
  const ro = m.isReadonly ? 'readonly ' : '';
  const opt = m.isOptional ? '?' : '';
  return `${ro}${m.name}${opt}${m.typeText ? `: ${m.typeText}` : ''}`;
}

/**
 * Per-kind usage-count + follow-up hint, plus a compact inline preview of the
 * declaration's own fields (class properties / interface members / entity
 * columns). Consumer LISTS are still left to the follow-up tools.
 */
async function buildMetadata(
  el: CodeElement,
  repo: IGraphReadRepository,
  scope: ScopeContext,
  uncapPreviews: boolean,
  collapsedKinds?: CodeElementType[],
): Promise<ExplainMetadata> {
  const kind = (el.type as CodeElementType) ?? 'unknown';
  const repoName = resolveRepoName(scope, el.id);
  const hasMultipleKinds = collapsedKinds !== undefined && collapsedKinds.length > 1;
  // An explicit detailLevel:'full' uncaps the inline field/value lists; the
  // default stays compact.
  const fieldLimit = uncapPreviews ? Number.POSITIVE_INFINITY : MAX_FIELD_PREVIEW;
  const meta: ExplainMetadata = {
    name: el.name,
    kind,
    ...(hasMultipleKinds && { kinds: collapsedKinds }),
    filePath: el.filePath,
    startLine: el.startLine,
    ...(el.endLine !== undefined && { endLine: el.endLine }),
    ...(el.summary && { summary: el.summary }),
    ...(repoName && { repo: repoName }),
  };

  // Inline the declaration's own structure (fields/members/values), then a
  // one-line navigation footer. Entities go through the describe_db_schema
  // dispatch before reaching here; the `entity` case below is the fall-through
  // for when that couldn't resolve. Consumer LISTS stay with the follow-up tools.
  switch (kind) {
    case 'class':
    case 'interface': {
      const usages = await repo.getTypeUsages(el.id, scope.repoHashes);
      const extensions =
        kind === 'class'
          ? await repo.getClassExtensions(el.id, scope.repoHashes)
          : await repo.getInterfaceImplementations(el.id, scope.repoHashes);
      meta.usageCount = usages.length + extensions.length;
      // The class figure spans every relation the graph now carries into a class: type-position
      // references, construction sites, imports (where the substrate detected them) and subclasses.
      // The "where extracted" qualifier is load-bearing — construction/import rows exist only for
      // substrates that detect them, so a zero is never proof that nothing constructs the class.
      meta.usageRelation =
        kind === 'class'
          ? 'type references + constructions + imports where extracted + subclasses'
          : 'type references + implementations';
      if (kind === 'class') {
        const cls = await repo.findClass(el.name, scope.repoHashes);
        applyFieldsPreview(meta, (cls?.properties ?? []).map(renderClassProperty), 'Properties', fieldLimit);
        applyMethodsPreview(meta, await classMethodLines(el, repo, scope), fieldLimit);
      } else {
        const iface = await repo.findInterface(el.name, scope.repoHashes);
        applyFieldsPreview(meta, (iface?.members ?? []).map(renderInterfaceMember), 'Members', fieldLimit);
      }
      meta.followUpHint = `find_dependents({name: "${el.name}", type: "${kind}"}) — ${kind === 'class' ? 'consumers/subclasses' : 'consumers/implementations'}`;
      if (meta.methods && meta.methods.length > 0) {
        meta.followUpHint += ` · explain({target: "${el.name}.<method>"}) — one method's body/call tree`;
      }
      break;
    }
    case 'enum': {
      const usages = await repo.getTypeUsages(el.id, scope.repoHashes);
      meta.usageCount = usages.length;
      // The count spans both relations the graph now carries: type references
      // to the enum itself AND value-position reads of one member. The
      // "where extracted" qualifier is load-bearing — value rows exist only
      // where the substrate detected them, so a zero is never proof that no
      // member is read anywhere.
      meta.usageRelation = 'type references + member-value reads where extracted';
      // Which half the figure is made of, and which members are branched on —
      // an added enum member silently bypasses exactly those call sites.
      const valueNote = memberValueUsageNote(usages, el.name);
      if (valueNote) meta.usageNote = valueNote;
      // Inline values — same {value, value, +N more} rendering as the column
      // suffix; uncapped at an explicit detailLevel:'full'. Answers "what are
      // the valid values?"
      const en = await repo.findEnum(el.name, scope.repoHashes);
      if (en?.members && en.members.length > 0) {
        meta.fieldsLabel = 'Values';
        meta.fieldsTotal = en.members.length;
        meta.fields = [enumValuesList(en.members, uncapPreviews ? Number.POSITIVE_INFINITY : undefined)];
      }
      meta.followUpHint = `find_dependents({name: "${el.name}", type: "enum"}) — consumers`;
      break;
    }
    case 'type_alias': {
      const usages = await repo.getTypeUsages(el.id, scope.repoHashes);
      meta.usageCount = usages.length;
      meta.usageRelation = 'type references';
      // Inline the resolved type expression (union members / object shape).
      const ta = await repo.findTypeAlias(el.name, scope.repoHashes);
      if (ta?.aliasedTypeText) applyFieldsPreview(meta, [ta.aliasedTypeText], 'Definition', fieldLimit);
      meta.followUpHint = `find_dependents({name: "${el.name}", type: "type_alias"}) — consumers`;
      break;
    }
    case 'entity': {
      // Fall-through only (describe_db_schema couldn't resolve it). Minimal
      // metadata + pointer, never error.
      const consumers = await repo.getEntityConsumers(el.name, scope.repoHashes);
      meta.usageCount = consumers.length;
      meta.usageRelation = 'functions that read or write it';
      meta.followUpHint = `describe_db_schema({entityName: "${el.name}"}) — columns/relations · find_entity_usage({entityName: "${el.name}"}) — read/write sites`;
      break;
    }
    case 'component':
    case 'variable':
    case 'route':
      // Structural detail (props / route target / declared type) isn't exposed
      // via the repo interface yet — point at the source for now.
      meta.followUpHint = `read ${el.filePath}:${el.startLine} for the full declaration`;
      break;
    default:
      break;
  }

  // A single source declaration can collapse to several node kinds, varying by
  // framework: class+entity (TypeORM/MikroORM model), class+component (React
  // class component), function+component (React FC — though that dispatches to
  // explain_function before reaching here). The switch above keyed only off the
  // precedence WINNER, so its follow-up hint ignores the other kinds. Append a
  // clause for each secondary kind so the agent sees every applicable tool
  // without having to know the parser's dual-kind quirk.
  if (hasMultipleKinds) {
    const secondaryClauses = collapsedKinds!
      .filter((k) => k !== kind)
      .map((k) => secondaryKindClause(k, el.name))
      .filter((clause): clause is string => clause !== null);
    if (secondaryClauses.length > 0) {
      meta.followUpHint = `${meta.followUpHint ?? ''} ${secondaryClauses.join(' ')}`.trim();
    }
  }
  return meta;
}

/**
 * A "this node is ALSO a <kind>" clause for the follow-up hint, naming the right
 * tool when one exists for that kind. Returns null for kinds whose dual nature
 * adds no actionable follow-up beyond reading the source (component/variable/
 * route have no first-class adjacency edge), so we don't pad the hint with noise.
 */
function secondaryKindClause(kind: CodeElementType, name: string): string | null {
  switch (kind) {
    case 'entity':
      return `Also an entity — describe_db_schema({entityName: "${name}"}) shows its columns/relations and find_entity_usage({entityName: "${name}"}) lists every read/write site.`;
    case 'class':
    case 'interface':
    case 'type_alias':
    case 'enum':
      return `Also a ${kind} — find_dependents({name: "${name}", type: "${kind}"}) lists every consumer.`;
    case 'component':
      return 'Also a UI component.';
    default:
      return null;
  }
}

/**
 * Append a one-line "Deeper:" navigation footer below an inlined structure
 * (summary mode only). Structure first, navigation hints second. Raw/structured
 * responses pass through untouched.
 */
function withDeeperFooter<T>(resp: McpResponse<T | string>, footer: string): McpResponse<T | string> {
  if (resp.isError || typeof resp.data !== 'string' || !footer) return resp;
  return { ...resp, data: `${resp.data}\n\n> Deeper: ${footer}` };
}

/**
 * Resolve a single code element to its explain response: functions dispatch to
 * handleExplainFunction (rich call tree / business logic), entities to
 * handleDescribeDbSchema (the byte-identical schema block), everything else
 * returns buildMetadata with the structure inlined. Shared by the bare-name and
 * `path:line` branches so both produce identical output for the same node.
 *
 * `detailLevel`/`detailConfig` are the values to FORWARD to sub-handlers
 * (full when the caller omitted the param — see handleExplain);
 * `uncapPreviews` gates the inline field/value previews independently, so
 * they stay compact unless the caller explicitly passed 'full'.
 */
async function dispatchSingleElement(
  el: CodeElement,
  target: string,
  scope: ScopeContext,
  format: OutputFormat,
  detailLevel: DetailLevel,
  detailConfig: DetailLevelConfig,
  repo: IGraphReadRepository,
  metadata: McpResponse<ExplainResult | string>['metadata'],
  includeSource: boolean,
  uncapPreviews: boolean,
  collapsedKinds?: CodeElementType[],
): Promise<McpResponse<ExplainResult | string>> {
  if (el.type === NodeType.Entrypoint) {
    // Entrypoint nodes store their node id in the `name` column, so the generic
    // metadata path below rendered `## <repoHash>:entrypoint:queue:<hash>` with
    // no handler, address or call tree. Deep-dive by id instead.
    debug('explain', 'dispatch: entrypoint (single element)');
    const epResp = await handleExplainEntrypoint(
      { id: el.id, includeSource },
      scope,
      format,
      detailLevel,
      detailConfig,
      repo,
    );
    if (!epResp.isError) {
      return epResp as McpResponse<ExplainResult | string>;
    }
    // Fall through to metadata only if the entrypoint vanished between queries.
  }
  if (el.type === NodeType.Function) {
    debug('explain', 'dispatch: function (single element)');
    const fnResp = await handleExplainFunction(
      { functionName: el.name, fileHint: el.filePath, includeSource },
      scope,
      format,
      detailLevel,
      detailConfig,
      repo,
    );
    if (!fnResp.isError) {
      // Pass through verbatim — see qualified branch for why.
      return fnResp as McpResponse<ExplainResult | string>;
    }
    // Rare: findCode said the function exists but findFunction couldn't
    // resolve it (likely a name-vs-id discrepancy). Fall through to the
    // metadata path so the agent gets at least file/line.
  }
  // Entities (incl. ORM models that the parser also stores as a class) reuse the
  // describe_db_schema handler so the schema block is byte-identical and the two
  // tools never drift. A "Deeper:" navigation footer is appended below it.
  const isEntity = el.type === NodeType.Entity || (el.type === NodeType.Class && collapsedKinds?.includes('entity'));
  if (isEntity) {
    debug('explain', 'dispatch: entity → describe_db_schema');
    const schemaResp = await handleDescribeDbSchema(
      { entityName: el.name },
      scope,
      format,
      detailLevel,
      detailConfig,
      repo,
    );
    if (!schemaResp.isError) {
      const alsoClass = el.type === NodeType.Class || collapsedKinds?.includes('class');
      const footer =
        `find_entity_usage({entityName: "${el.name}"}) — read/write sites` +
        (alsoClass ? ` · find_dependents({name: "${el.name}", type: "class"}) — consumers/subclasses` : '');
      return withDeeperFooter(schemaResp, footer) as McpResponse<ExplainResult | string>;
    }
    // Couldn't resolve the entity — fall through to minimal metadata, never error.
  }
  if (METADATA_KINDS.has(el.type as CodeElementType)) {
    const meta = await buildMetadata(el, repo, scope, uncapPreviews || includeSource, collapsedKinds);
    if (includeSource) {
      // The ingestion path stores raw bodies only for function nodes. Type
      // contracts above come from extracted members, not a stored source body.
      meta.sourceUnavailableReason = allowSourcesInGraph() ? 'not-stored-for-kind' : 'disabled';
    }
    if (['class', 'interface', 'type_alias', 'enum'].includes(meta.kind) && !meta.fields?.length) {
      meta.structureNote =
        'No field/member definition is available in this snapshot. This does not prove the declaration is empty; inspect the source file for its contract.';
    }
    return formatExplain({ target, resolution: 'metadata', metadata: meta }, metadata);
  }
  // Unknown kind — return as raw metadata anyway so the agent at least sees
  // the file/line.
  const hasMultipleKinds = collapsedKinds !== undefined && collapsedKinds.length > 1;
  return formatExplain(
    {
      target,
      resolution: 'metadata',
      metadata: {
        name: el.name,
        kind: (el.type as CodeElementType) ?? 'unknown',
        ...(hasMultipleKinds && { kinds: collapsedKinds }),
        filePath: el.filePath,
        startLine: el.startLine,
        ...(el.endLine !== undefined && { endLine: el.endLine }),
        ...(el.summary && { summary: el.summary }),
        ...(resolveRepoName(scope, el.id) && { repo: resolveRepoName(scope, el.id) }),
      },
    },
    metadata,
  );
}

/**
 * Try to read `target` as a queue/event/cron/CLI entrypoint ADDRESS — a topic
 * constant (`Topics.DailySummaryRecalculateV2`), its bare last segment, or the
 * literal destination string — and deep-dive that entrypoint.
 *
 * Needed because entrypoints are not name-addressable: the parser stores the
 * node id in their `name` column (see NAME_ADDRESSABLE_KINDS), so a topic name
 * dead-ended on "not found" even though `list_entrypoints` prints it. Runs only
 * on the miss paths, so a normal symbol explain pays nothing for it.
 *
 * Returns null when nothing matches, so the caller can continue to its own
 * fuzzy/not-found handling.
 */
async function resolveEntrypointByAddress(
  target: string,
  scope: ScopeContext,
  format: OutputFormat,
  detailLevel: DetailLevel,
  detailConfig: DetailLevelConfig,
  repo: IGraphReadRepository,
  metadata: McpResponse<ExplainResult | string>['metadata'],
  includeSource: boolean,
): Promise<McpResponse<ExplainResult | string> | null> {
  const wanted = target.trim().toLowerCase();
  if (!wanted) return null;
  // pathPattern is substring-matched across every address field, so this both
  // narrows the scan and lets a bare segment ("DailySummaryRecalculateV2") hit
  // a qualified destination ("Topics.DailySummaryRecalculateV2").
  const entrypoints = await repo.listEntrypoints({ pathPattern: target }, scope.repoHashes);
  const matches = entrypoints.filter((ep) =>
    entrypointAddressTokens(ep).some((token) => {
      const t = token.trim().toLowerCase();
      return t === wanted || bareName(t) === wanted;
    }),
  );
  debugResult('resolveEntrypointByAddress', matches.length);
  if (matches.length === 0) return null;

  const first = matches[0]!;
  if (matches.length === 1 || matches.every((ep) => ep.id === first.id)) {
    debug('explain', `dispatch: entrypoint by address (${first.id})`);
    const epResp = await handleExplainEntrypoint(
      { id: first.id, includeSource },
      scope,
      format,
      detailLevel,
      detailConfig,
      repo,
    );
    if (!epResp.isError) return epResp as McpResponse<ExplainResult | string>;
    return null;
  }

  return formatExplain(
    {
      target,
      resolution: 'disambiguation',
      candidates: matches.slice(0, 10).map((ep) => ({
        name: entrypointAddressTokens(ep)[0] ?? ep.handlerName ?? ep.id,
        kind: 'entrypoint' as CodeElementType,
        filePath: ep.filePath,
        startLine: ep.startLine,
        ...(resolveRepoName(scope, ep.id) && { repo: resolveRepoName(scope, ep.id) }),
      })),
      hint: `"${target}" matches several entrypoints. Re-call \`explain\` with the file location (\`path:line\`) of the one you want.`,
    },
    metadata,
  );
}

/**
 * How many out-of-scope rows the sibling-repository probe pulls. Enough to span
 * several repos without paying for a fleet-wide listing on a typo.
 */
const SIBLING_PROBE_LIMIT = 25;

/**
 * Repo names OUTSIDE the current scope that declare `name`, sorted and deduped.
 * Empty when the scope is already the whole graph (nothing to widen to) or when
 * it is a hard boundary — a cloud workspace scope enumerates the connected
 * repos and must not report rows beyond them.
 */
async function repositoriesDeclaring(repo: IGraphReadRepository, scope: ScopeContext, name: string): Promise<string[]> {
  if (scope.repoHashes.length === 0) return [];
  if (crossRepoLookupHashes(scope).length !== 0) return [];

  const rows = await repo.findCode(
    { pattern: `*${name}*`, types: NAME_ADDRESSABLE_KINDS, limit: SIBLING_PROBE_LIMIT },
    [],
  );
  const lower = name.toLowerCase();
  const inScope = new Set(scope.repoHashes);
  const hashes = new Set<string>();
  for (const row of rows) {
    if (row.name.toLowerCase() !== lower) continue;
    const hash = row.id.split(':')[0];
    if (hash && !inScope.has(hash)) hashes.add(hash);
  }
  if (hashes.size === 0) return [];

  const names = await repo.getRepositoryNames([...hashes]);
  return [...new Set(names.map((row) => row.name).filter(Boolean))].sort();
}

/**
 * Resolution algorithm (in order):
 *   1. Empty / whitespace target → not-found with a usage hint.
 *   2. HTTP-shaped target → handleExplainEntrypoint.
 *   3. `path:line` target (`src/foo.ts:42`) → symbol enclosing that line.
 *   3b. Bare file path (`src/foo.ts`) that resolves → the file's symbols.
 *   4. Qualified name (`Class.method`) → handleExplainFunction with className.
 *   5. Bare name → findCode + EXACT name post-filter (case-insensitive):
 *        • 1 hit, function → handleExplainFunction
 *        • 1 hit, other kinds → buildMetadata
 *        • N hits → disambiguation (return all candidates, no auto-pick)
 *        • 0 hits → fuzzy fallback (`*target*`) capped at 5 candidates
 */
export async function handleExplain(
  args: Record<string, unknown>,
  scope: ScopeContext,
  format: OutputFormat,
  detailLevel: DetailLevel,
  detailConfig: DetailLevelConfig,
  repository: IGraphReadRepository,
): Promise<McpResponse<ExplainResult | string>> {
  const rawTarget = (args.target as string | undefined) ?? '';
  const target = rawTarget.trim().replace(/^`+|`+$/g, '');
  const fileHint = args.fileHint as string | undefined;
  const explicitClassName = args.className as string | undefined;
  // Forwarded to the function dispatch; gated by ALLOW_SOURCES_IN_GRAPH inside
  // handleExplainFunction (and the param only appears in the schema when enabled).
  const includeSource = args.includeSource === true;

  // explain is compact-by-default: the dispatcher resolves an omitted
  // detailLevel to 'basic' (getDefaultDetailLevel), so only an explicit 'full'
  // uncaps the inline field/value previews. The function/entrypoint/entity
  // sub-dispatches still render their full structure when the param was
  // omitted — an omitted param must not strip AI summaries from a function
  // explain — so they get the full config unless the caller explicitly
  // narrowed to 'basic' (raw-arg presence check, same idea as
  // describe_db_schema's `explicitFull`).
  const requestedDetail = args.detailLevel as DetailLevel | undefined;
  const uncapPreviews = detailLevel === 'full';
  const subDetailLevel: DetailLevel = requestedDetail === undefined ? 'full' : detailLevel;
  const subDetailConfig: DetailLevelConfig = requestedDetail === undefined ? resolveDetailLevel('full') : detailConfig;

  const metadata = await createMetadata(scope, format, detailLevel, detailConfig, repository);

  if (!target) {
    const result: ExplainResult = {
      target: rawTarget,
      resolution: 'not-found',
      hint: 'Pass `target` — a symbol name (e.g. `BookingService.createBooking`), a class/interface/entity name, or an HTTP path like `POST /v1/users`.',
    };
    return formatExplain(result, metadata);
  }

  debug('explain', `target="${target}", scope=[${scope.resolvedRepos.join(',')}], fileHint=${fileHint}`);

  // --- 1) HTTP-shaped → entrypoint dispatcher ---
  // Pass the sub-tool's response through verbatim. In summary mode that's
  // the formatted prose (`## Endpoint: ...`); in raw mode it's the
  // structured EntrypointExplanationResult. We don't re-wrap into
  // ExplainResult — the user wants what they'd get from a direct
  // explain_entrypoint call. `isError` lets us distinguish miss from hit
  // without sniffing prose content.
  if (looksLikeHttpPath(target)) {
    debug('explain', 'dispatch: entrypoint');
    const epResp = await handleExplainEntrypoint(
      { path: target, includeSource },
      scope,
      format,
      subDetailLevel,
      subDetailConfig,
      repository,
    );
    if (!epResp.isError) {
      return epResp as McpResponse<ExplainResult | string>;
    }
    // Miss — convert to an explain-shaped not-found so the response shape
    // stays consistent across the four outcomes (function / entrypoint /
    // metadata / not-found).
    return formatExplain(
      {
        target,
        resolution: 'not-found',
        hint: typeof epResp.data === 'string' ? epResp.data : `Entrypoint "${target}" not found in scope.`,
      },
      epResp.metadata,
    );
  }

  // --- 1b) `path:line` → symbol enclosing that line ---
  // Agents often have a stack-frame / grep hit (`src/foo.ts:42`) and want "what
  // is here?" without first knowing the symbol name. List the file's symbols
  // and pick the innermost declaration spanning the line.
  const pathLine = parsePathLine(target);
  if (pathLine) {
    debug('explain', `dispatch: path:line (${pathLine.filePath}:${pathLine.line})`);
    const fileSymbols = await repository.listSymbolsInFile(pathLine.filePath, scope.repoHashes);
    const dedupedWithKinds = dedupeByKinds(fileSymbols);
    const deduped = dedupedWithKinds.map((m) => m.element);
    const picked = pickSymbolAtLine(deduped, pathLine.line);
    if (picked) {
      const pickedKinds = dedupedWithKinds.find((m) => m.element === picked)?.kinds;
      return dispatchSingleElement(
        picked,
        target,
        scope,
        format,
        subDetailLevel,
        subDetailConfig,
        repository,
        metadata,
        includeSource,
        uncapPreviews,
        pickedKinds,
      );
    }
    return formatExplain(
      {
        target,
        resolution: 'not-found',
        hint:
          deduped.length === 0
            ? `No file matching "${pathLine.filePath}" in scope${scope.resolvedRepos.length > 0 ? ` (${scope.resolvedRepos.join(', ')})` : ''}. Check the path (it matches exactly or by trailing segment). Use \`list_file_symbols\` to inspect a file.`
            : `No symbol spans line ${pathLine.line} in "${pathLine.filePath}". Use \`list_file_symbols\` to see what's there.`,
      },
      metadata,
    );
  }

  // --- 1c) bare file path → the file's symbols ---
  // `explain("apps/studio/pages/.../users.tsx")` used to fall into the symbol
  // lookup and dead-end on not-found, even though the file is right there in
  // the graph. Route it to the same view `list_file_symbols` renders (one
  // renderer, so the two tools can't drift), plus a "Deeper:" footer.
  //
  // Only when the file actually resolves: a miss falls through to the symbol
  // lookup so the did-you-mean flow still runs on a mistyped path.
  if (looksLikeFilePath(target)) {
    debug('explain', `dispatch: file path (${target})`);
    const fileRows = await repository.listSymbolsInFile(target, scope.repoHashes);
    if (fileRows.length > 0) {
      const fileResp = await handleListFileSymbols(
        { path: target },
        scope,
        format,
        subDetailLevel,
        subDetailConfig,
        repository,
      );
      return withDeeperFooter(
        fileResp as McpResponse<ExplainResult | string>,
        `explain({target: "${target}:<line>"}) — the symbol at a line · explain({target: "<symbol>"}) — any symbol listed above`,
      );
    }
    debug('explain', 'file path did not resolve; falling through to symbol lookup');
  }

  // --- 2) Qualified name → function dispatcher ---
  // When the agent passes `Class.method` or supplies `className` explicitly,
  // honor the class constraint. If the qualified lookup fails we DO NOT
  // silently fall back to bare-name search — that broadens the agent's
  // intent and returns unrelated symbols (e.g. typing `TemplateService.X`
  // would return matches for `X` in unrelated classes). Instead, surface
  // class-name suggestions so the agent can correct the qualifier.
  const parsed = parseFunctionName(target);
  const className = explicitClassName ?? parsed.requestedClassName;
  if (className) {
    // When explicit className was passed alongside an unqualified target,
    // compose the qualified form so handleExplainFunction's parseFunctionName
    // sees the right class (it reads only args.functionName today).
    const qualifiedName =
      parsed.requestedClassName === undefined && explicitClassName ? `${explicitClassName}.${target}` : target;

    debug('explain', `dispatch: function (qualified, class=${className})`);
    const fnResp = await handleExplainFunction(
      { functionName: qualifiedName, fileHint, className, includeSource },
      scope,
      format,
      subDetailLevel,
      subDetailConfig,
      repository,
    );
    if (!fnResp.isError) {
      // Pass through verbatim — the prose / raw object is exactly what the
      // user wants. Wrapping it in ExplainResult would force a re-format
      // that strips business logic / call tree / side effects in summary
      // mode.
      return fnResp as McpResponse<ExplainResult | string>;
    }

    // Qualified miss. A topic constant reads as `Class.member`
    // (`Topics.DailySummaryRecalculateV2`), so try entrypoint addressing before
    // suggesting classes.
    const epByAddress = await resolveEntrypointByAddress(
      target,
      scope,
      format,
      subDetailLevel,
      subDetailConfig,
      repository,
      metadata,
      includeSource,
    );
    if (epByAddress) return epByAddress;

    // Find classes with names similar to the qualifier so
    // the agent can see "you typed TemplateService, did you mean
    // TemplatesService?" — beats silently returning matches for the bare
    // method name from a different class.
    debug('explain', `qualified lookup miss; looking for class candidates near "${className}"`);
    const classCandidates = await repository.findCode(
      { pattern: `*${className}*`, types: [NodeType.Class, NodeType.Interface], limit: 5 },
      scope.repoHashes,
    );
    if (classCandidates.length > 0) {
      return formatExplain(
        {
          target,
          resolution: 'fuzzy',
          candidates: classCandidates.map((c) => toCandidate(c, scope)),
          hint: `No method \`${parsed.lookupName}\` on class \`${className}\` in scope${scope.resolvedRepos.length > 0 ? ` (${scope.resolvedRepos.join(', ')})` : ''}. Did you mean one of these classes?`,
        },
        metadata,
      );
    }
    return formatExplain(
      {
        target,
        resolution: 'not-found',
        hint: `No method \`${parsed.lookupName}\` on class \`${className}\` in scope${scope.resolvedRepos.length > 0 ? ` (${scope.resolvedRepos.join(', ')})` : ''}. The class itself wasn't found either.`,
      },
      metadata,
    );
  }

  // --- 3) Bare name → findCode with exact post-filter ---
  const lookupName = parsed.lookupName;
  debug('findCode', `pattern="${lookupName}", scope=[${scope.repoHashes.join(',')}]`);
  // Cast a slightly wider net than the post-filter requires, so an exact
  // match buried alphabetically after near-misses still surfaces. 50 is
  // enough for any realistic name collision.
  const candidates = await repository.findCode(
    { pattern: `*${lookupName}*`, types: NAME_ADDRESSABLE_KINDS, limit: 50 },
    scope.repoHashes,
  );
  const lower = lookupName.toLowerCase();
  let exact = candidates.filter((c) => c.name.toLowerCase() === lower);

  // Honor fileHint as a narrowing filter when explicit.
  if (fileHint) {
    const hinted = exact.filter((c) => c.filePath === fileHint || c.filePath.endsWith(`/${fileHint}`));
    if (hinted.length > 0) exact = hinted;
  }

  // Collapse the React FC `{component, function}` duplicates the parser
  // emits for every functional component — without this, `ShiftForm` (and
  // every other React FC) returned a disambiguation list with two rows
  // pointing at the same file+line, which fileHint couldn't resolve. Keep the
  // collapsed kind set so a single-hit class+entity can advertise both
  // follow-up tools.
  const exactWithKinds = dedupeByKinds(exact);
  exact = exactWithKinds.map((m) => m.element);

  debugResult('findCode', exact.length);

  // 3a) Exactly one hit → dispatch / metadata.
  if (exact.length === 1) {
    return dispatchSingleElement(
      exact[0]!,
      target,
      scope,
      format,
      subDetailLevel,
      subDetailConfig,
      repository,
      metadata,
      includeSource,
      uncapPreviews,
      exactWithKinds[0]!.kinds,
    );
  }

  // 3b) Multiple exact hits → disambiguation. Common case: entity + class
  // share a name (`DailySummary`), or two intercepter classes collide.
  if (exact.length > 1) {
    const cands = exact.slice(0, 10).map((c) => toCandidate(c, scope));
    return formatExplain(
      {
        target,
        resolution: 'disambiguation',
        candidates: cands,
        hint: 'Multiple matches. Re-call with `fileHint` (path) or `className` (for methods) to pick one.',
      },
      metadata,
    );
  }

  // 3c) Zero exact hits → entrypoint addressing (topics/destinations/schedules
  // are not name-addressable), then fuzzy fallback.
  const epByAddress = await resolveEntrypointByAddress(
    target,
    scope,
    format,
    subDetailLevel,
    subDetailConfig,
    repository,
    metadata,
    includeSource,
  );
  if (epByAddress) return epByAddress;

  // `candidates` already holds the
  // substring matches from findCode above, so we just rank them for the
  // "did you mean…?" list. Match bare-name first (handles `Class.method`
  // typos), then alphabetical. Dedupe React FC pairs first so the fuzzy
  // suggestion list isn't half-filled with duplicate {component,function}
  // rows pointing at the same file+line.
  const fuzzyDeduped = dedupeParserDuplicates(candidates);
  if (fuzzyDeduped.length > 0) {
    const ranked = [...fuzzyDeduped].sort((a, b) => {
      const aBare = bareName(a.name).toLowerCase() === lower ? 0 : 1;
      const bBare = bareName(b.name).toLowerCase() === lower ? 0 : 1;
      if (aBare !== bBare) return aBare - bBare;
      return a.name.localeCompare(b.name);
    });
    return formatExplain(
      {
        target,
        resolution: 'fuzzy',
        candidates: ranked.slice(0, 5).map((c) => toCandidate(c, scope)),
        hint: `No exact match for "${target}". Did you mean one of these? Re-call \`explain\` with the exact name.`,
      },
      metadata,
    );
  }

  // 3d) Nothing at all. A scoped miss is not the same fact as "this symbol does
  // not exist", so name the sibling repos that do declare it before falling back
  // to the generic widen-your-search advice.
  const elsewhere = await repositoriesDeclaring(repository, scope, lookupName);
  if (elsewhere.length > 0) {
    return formatExplain(
      {
        target,
        resolution: 'not-found',
        hint: declaredElsewhereLine(target, elsewhere),
      },
      metadata,
    );
  }
  return formatExplain(
    {
      target,
      resolution: 'not-found',
      hint: `"${target}" not found in scope${scope.resolvedRepos.length > 0 ? ` (${scope.resolvedRepos.join(', ')})` : ''}. Try \`describe_repository\` to list available repos, or \`search_symbols\` with a wider pattern.`,
    },
    metadata,
  );
}
