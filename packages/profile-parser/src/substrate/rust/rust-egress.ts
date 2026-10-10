/**
 * Rust HTTP EGRESS extraction — outbound HTTP calls a Rust service makes to OTHER services, so
 * it becomes a cross-repo CONSUMER. Generic HTTP client CRATES only (`reqwest`/`hyper`,
 * profile-configurable); NO client-specific hosts, paths or type names.
 *
 * Detection is precision-first, porting `python-egress.ts`'s receiver-gate architecture: a verb
 * call (`get|post|put|patch|delete|head|options`) counts only when its receiver ROOT resolves to
 * a client. Three tiers resolve, everything else is skipped:
 *
 *   (a) the crate itself — `reqwest::get(url)`, or a receiver rooted at `reqwest`/an alias the
 *       file's `use` table binds to a client crate;
 *   (b) a LOCAL bound to a client constructor — `let c = Client::new();` then `c.get(url)`;
 *   (c) a STRUCT FIELD whose declared type is a client — `self.http.get(url)` where the
 *       enclosing `impl`'s struct declares `http: reqwest::Client`.
 *
 * Tier (c) is a genuine capability gain over the Python substrate, which cannot type an untyped
 * `self.session` — and it is the shape most production Rust services actually use.
 *
 * A bare `x.get(...)` whose origin is untraceable is SKIPPED: `.get` is also `HashMap::get`,
 * `Vec::get` and `Option::get`, so an ungated verb match would bury the real egress edges.
 */
import type { ExternalCallEdge, HttpMethod, StableIdGenerator } from '@coredoc/core';
import {
  CALL_EXPRESSION,
  DEF_TYPES,
  FIELD_EXPRESSION,
  IMPL_ITEM,
  MACRO_INVOCATION,
  type RustFile,
  SCOPED_IDENTIFIER,
  STRUCT_ITEM,
  type TsNode,
  baseTypeName,
  itemName,
  nearestAncestor,
  rustFunctionId,
  rustStringValue,
} from './rust-cst.js';
import { type UseTable, buildUseTable } from './rust-imports.js';
import { toPathTemplate } from '../scip/url-topic-helpers.js';

/** Per-repo egress tuning — the HTTP client crates to treat as outbound calls. */
export interface RustEgressConfig {
  /** Client crates whose verb methods are egress. Default `['reqwest','hyper']`. */
  clientCrates?: string[];
}

const DEFAULT_CLIENT_CRATES = ['reqwest', 'hyper'];
const VERBS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);
/** Constructors that yield a client value (`Client::new()`, `Client::builder().build()`). */
const CLIENT_TYPE_NAMES = new Set(['Client', 'ClientBuilder']);

/**
 * The leftmost token of a receiver expression — the "root" the call chains off. Descends
 * `field_expression.value`, `call_expression.function`, `generic_function`, `try_expression`
 * and `await_expression` until an identifier, `self` or a path head is reached.
 *
 * A `scoped_identifier`'s `path` field is the whole prefix, not the head — `reqwest::Client::new`
 * gives `reqwest::Client`, which matches no crate name and no `use` binding. Returning the HEAD
 * segment is what makes the inline `reqwest::Client::new().get(url)` shape resolve.
 */
function receiverRoot(node: TsNode | undefined | null): string | undefined {
  let cur: TsNode | undefined | null = node;
  while (cur) {
    switch (cur.type) {
      case 'identifier':
      case 'self':
      case 'field_identifier':
        return cur.text as string;
      case SCOPED_IDENTIFIER:
        return ((cur.childForFieldName?.('path')?.text ?? cur.text) as string).split('::')[0];
      case FIELD_EXPRESSION:
        cur = cur.childForFieldName?.('value');
        break;
      case CALL_EXPRESSION:
        cur = cur.childForFieldName?.('function');
        break;
      case 'generic_function':
        cur = cur.childForFieldName?.('function') ?? cur.namedChild?.(0);
        break;
      case 'await_expression':
      case 'try_expression':
      case 'reference_expression':
      case 'unary_expression':
      case 'parenthesized_expression':
        cur = cur.namedChild?.(0);
        break;
      default:
        return undefined;
    }
  }
  return undefined;
}

/** Whether a path head names a configured client crate, directly or via the file's `use` table. */
function isClientPath(head: string, table: UseTable, clientCrates: string[]): boolean {
  if (clientCrates.includes(head)) return true;
  const binding = table.byLocal.get(head);
  if (!binding) return false;
  return clientCrates.includes(binding.path.split('::')[0]);
}

/**
 * Whether an expression CONSTRUCTS a client: `reqwest::Client::new()`, `Client::builder()…`, or
 * a bare `Client::new()` whose `Client` the `use` table binds into a client crate.
 */
function constructsClient(node: TsNode | undefined, table: UseTable, clientCrates: string[]): boolean {
  if (!node) return false;
  for (const call of [node, ...((node.descendantsOfType?.(CALL_EXPRESSION) ?? []) as TsNode[])]) {
    const fn = call?.childForFieldName?.('function');
    if (fn?.type !== SCOPED_IDENTIFIER) continue;
    const path = (fn.text ?? '') as string;
    const segments = path.split('::');
    if (segments.length < 2) continue;
    const typeName = segments[segments.length - 2];
    if (!CLIENT_TYPE_NAMES.has(typeName)) continue;
    // `reqwest::Client::new()` names the crate outright; a bare `Client::new()` must be bound
    // to a client crate by a `use`, else it is some other library's `Client`.
    if (
      segments.length > 2 ? isClientPath(segments[0], table, clientCrates) : isClientPath(typeName, table, clientCrates)
    ) {
      return true;
    }
  }
  return false;
}

/** Whether a written-down type is a client type from a configured crate. */
function isClientType(typeText: string | undefined, table: UseTable, clientCrates: string[]): boolean {
  if (!typeText) return false;
  const base = baseTypeName(typeText);
  if (!base || !CLIENT_TYPE_NAMES.has(base)) return false;
  const head = typeText
    .replace(/^[&*]+\s*(mut\s+)?/, '')
    .split('::')[0]
    .split('<')[0]
    .trim();
  return isClientPath(head, table, clientCrates) || isClientPath(base, table, clientCrates);
}

/**
 * Local names bound to a client value anywhere in the file (tier b): a `let` bound to a client
 * constructor, a `let` with a DECLARED client type, or a fn PARAMETER with one. A parameter's
 * declared type is the same evidence class as tier (c)'s struct field — Rust writes the type
 * down at the binding site — and it is how a helper receives the client in most test/CLI code.
 *
 * Bindings are collected per file and are not flow-sensitive: a name bound to a client anywhere
 * in the file counts throughout it, matching the python-egress precedent.
 */
function clientLocals(file: RustFile, table: UseTable, clientCrates: string[]): Set<string> {
  const names = new Set<string>();
  for (const param of file.root.descendantsOfType('parameter') as TsNode[]) {
    const pattern = param.childForFieldName?.('pattern');
    if (pattern?.type !== 'identifier') continue;
    if (isClientType(param.childForFieldName?.('type')?.text as string | undefined, table, clientCrates)) {
      names.add(pattern.text as string);
    }
  }
  for (const decl of file.root.descendantsOfType('let_declaration') as TsNode[]) {
    const pattern = decl.childForFieldName?.('pattern');
    if (pattern?.type !== 'identifier') continue;
    // A declared client type is as good as a constructor: `let c: reqwest::Client = …`.
    const declType = decl.childForFieldName?.('type')?.text as string | undefined;
    if (
      isClientType(declType, table, clientCrates) ||
      constructsClient(decl.childForFieldName?.('value'), table, clientCrates)
    ) {
      names.add(pattern.text as string);
    }
  }
  return names;
}

/** Struct field names whose DECLARED type is a client, per struct (tier c). */
function clientFieldsByStruct(file: RustFile, table: UseTable, clientCrates: string[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const structNode of file.root.descendantsOfType(STRUCT_ITEM) as TsNode[]) {
    const structName = itemName(structNode);
    if (!structName) continue;
    const fields = new Set<string>();
    for (const fd of structNode.descendantsOfType('field_declaration') as TsNode[]) {
      const fieldName = fd.childForFieldName?.('name')?.text as string | undefined;
      const typeText = fd.childForFieldName?.('type')?.text as string | undefined;
      if (!fieldName || !typeText) continue;
      // `reqwest::Client` names the crate; a bare `Client` must be `use`-bound to one.
      if (isClientType(typeText, table, clientCrates)) fields.add(fieldName);
    }
    if (fields.size > 0) out.set(structName, fields);
  }
  return out;
}

// =============================================================================
// Path templates
// =============================================================================

/**
 * A `format!("…{}…{name}…", a, b)` template rendered as a path: inline `{name}` captures keep
 * their name, positional `{}` become the linker's `{_}` token, and a LEADING interpolation is
 * the host (`format!("{}/v1/x", base)`) and is dropped.
 */
function formatMacroTemplate(macro: TsNode): string | undefined {
  const tree = macro.child(macro.childCount - 1) as TsNode | undefined;
  const first = tree?.namedChild?.(0) as TsNode | undefined;
  const raw = first ? rustStringValue(first) : undefined;
  if (raw === undefined) return undefined;
  let out = '';
  let sawContent = false;
  // Split on placeholders, keeping them, so a leading one can be recognized as the host.
  for (const part of raw.split(/(\{[^{}]*\})/)) {
    if (!part) continue;
    const placeholder = /^\{([^{}]*)\}$/.exec(part);
    if (!placeholder) {
      out += part;
      if (part.length > 0) sawContent = true;
      continue;
    }
    if (!sawContent) continue; // leading interpolation = the host → dropped
    // An inline capture (`{id}`) keeps its name; a positional/formatted `{}` / `{:?}` renders as
    // the linker's positional param token so it normalizes like a named one.
    const name = placeholder[1].split(':')[0].trim();
    out += name && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? `{${name}}` : '{_}';
  }
  return out;
}

/** The raw template of an egress call's first argument (a literal or a `format!`). */
function argTemplate(arg: TsNode | undefined): string | undefined {
  if (!arg) return undefined;
  if (arg.type === 'string_literal' || arg.type === 'raw_string_literal') return rustStringValue(arg);
  const macro =
    arg.type === MACRO_INVOCATION ? arg : ((arg.descendantsOfType?.(MACRO_INVOCATION) ?? [])[0] as TsNode | undefined);
  if (macro && (macro.childForFieldName?.('macro')?.text as string | undefined) === 'format') {
    return formatMacroTemplate(macro);
  }
  return undefined;
}

/** Build the `ExternalCallEdge` for one egress call site. */
function egressEdge(
  idGen: StableIdGenerator,
  relPath: string,
  callNode: TsNode,
  method: string,
  path: string,
  originalPath: string,
): ExternalCallEdge {
  const line = (callNode.startPosition.row as number) + 1;
  const enclosing = nearestAncestor(callNode, DEF_TYPES);
  const callerId = enclosing ? rustFunctionId(idGen, relPath, enclosing) : idGen.functionId(relPath, `egress@${line}`);
  const id = idGen.externalCallId(callerId, '', method, `${relPath}:${line}:${path}`);
  return {
    id,
    versionedId: idGen.versionedId(id, `${method} ${path}`),
    callerId,
    // NOT the transport literal 'http' — that collides with the linker's `unresolvableServices`
    // and would exclude every egress call. The target service is unknown at extraction; the
    // linker recovers it from the route prefix instead.
    serviceName: '',
    method,
    targetDescriptor: {
      protocol: 'http',
      http: { method: method as HttpMethod, pathTemplate: path, originalPath },
    },
    location: { filePath: relPath, startLine: line, endLine: line },
  };
}

/**
 * Extract outbound HTTP client calls across `files` into `ExternalCallEdge`s (`serviceName=''`,
 * a joinable path template with interpolations preserved). One edge per call site.
 */
export function extractRustEgress(
  files: RustFile[],
  idGen: StableIdGenerator,
  cfg: RustEgressConfig,
): ExternalCallEdge[] {
  const clientCrates = cfg.clientCrates ?? DEFAULT_CLIENT_CRATES;
  const out: ExternalCallEdge[] = [];

  for (const file of files) {
    const table = buildUseTable(file);
    const locals = clientLocals(file, table, clientCrates);
    const fieldsByStruct = clientFieldsByStruct(file, table, clientCrates);

    for (const call of file.root.descendantsOfType(CALL_EXPRESSION) as TsNode[]) {
      const fn = call.childForFieldName?.('function') as TsNode | undefined;
      if (!fn) continue;

      let verb: string | undefined;
      let gated = false;

      if (fn.type === SCOPED_IDENTIFIER) {
        // `reqwest::get(url)` — the crate is named at the call site.
        verb = fn.childForFieldName?.('name')?.text as string | undefined;
        const head = (fn.childForFieldName?.('path')?.text ?? '').split('::')[0];
        gated = !!verb && VERBS.has(verb) && isClientPath(head, table, clientCrates);
      } else if (fn.type === FIELD_EXPRESSION) {
        verb = fn.childForFieldName?.('field')?.text as string | undefined;
        if (verb && VERBS.has(verb)) {
          const receiver = fn.childForFieldName?.('value') as TsNode | undefined;
          const root = receiverRoot(receiver);
          if (root && (isClientPath(root, table, clientCrates) || locals.has(root))) {
            gated = true;
          } else if (
            receiver?.type === FIELD_EXPRESSION &&
            (receiver.childForFieldName?.('value')?.text as string) === 'self'
          ) {
            // Tier (c): `self.<field>.get(…)` where the enclosing impl's struct declares
            // `<field>: reqwest::Client`.
            const fieldName = receiver.childForFieldName?.('field')?.text as string | undefined;
            const implNode = nearestAncestor(call, new Set([IMPL_ITEM]));
            const structName = implNode ? baseTypeName(implNode.childForFieldName?.('type')?.text) : undefined;
            gated = !!fieldName && !!structName && (fieldsByStruct.get(structName)?.has(fieldName) ?? false);
          }
        }
      }
      if (!gated || !verb) continue;

      const args = call.childForFieldName?.('arguments') as TsNode | undefined;
      const raw = argTemplate(args?.namedChild?.(0) as TsNode | undefined);
      if (raw === undefined) continue;
      const path = toPathTemplate(raw);
      if (!path) continue; // host-only / non-path literal → no bogus hostless edge

      out.push(egressEdge(idGen, file.relPath, call, verb.toUpperCase(), path, raw));
    }
  }
  return out;
}
