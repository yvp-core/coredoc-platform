/**
 * Profile typecheck gate.
 *
 * A profile is authored TypeScript, but the CLI loads it via `ts.transpileModule`,
 * which is a single-file syntactic transform — it never checks types. A profile that
 * names a field the schema does not have (`stateStores[].kind`, `ComponentRule.detect`)
 * or calls a fact the substrate does not expose (`ArgNode.type`) therefore loads
 * cleanly and extracts nothing: the rule is structurally dead, the parse reports
 * success, and the missing nodes look like a repo with no routes.
 *
 * This module runs a real semantic check over the profile before it is trusted.
 * Diagnostics are filtered to the profile file itself — the engine's own sources are
 * pulled in only to supply the schema, and their unrelated errors are not the
 * profile author's problem.
 */

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/** One semantic error in a profile, located in the profile's own source. */
export interface ProfileDiagnostic {
  /** Absolute path of the profile file. */
  file: string;
  /** 1-based. */
  line: number;
  /** 1-based. */
  column: number;
  /** TypeScript diagnostic code, e.g. 2353 (unknown property). */
  code: number;
  message: string;
}

export class ProfileTypeError extends Error {
  constructor(
    readonly profilePath: string,
    readonly diagnostics: ProfileDiagnostic[],
  ) {
    super(formatProfileDiagnostics(profilePath, diagnostics));
    this.name = 'ProfileTypeError';
  }
}

/** One executable capability that is outside the declarative profile contract. */
export interface ProfileCapabilityViolation {
  /** Absolute path of the profile file. */
  file: string;
  /** 1-based. */
  line: number;
  /** 1-based. */
  column: number;
  message: string;
}

export class ProfileCapabilityError extends Error {
  constructor(
    readonly profilePath: string,
    readonly violations: ProfileCapabilityViolation[],
  ) {
    super(formatProfileCapabilityViolations(profilePath, violations));
    this.name = 'ProfileCapabilityError';
  }
}

/**
 * Explicit override for the directory holding this package's schema (`dist/index.d.ts` or
 * `src/index.ts`).
 *
 * Hosts that BUNDLE the engine — the desktop app esbuilds it into its parse worker — leave this
 * module with no package of its own on disk: `import.meta.url` points into the bundle, and the
 * nearest package.json walking up is the bundler's own stub. The host knows where the real
 * package copy lives and points this at it.
 */
const SCHEMA_DIR_ENV = 'COREDOC_PROFILE_SCHEMA_DIR';

/** A directory is a usable schema root only if it actually carries an entry to compile against. */
function hasSchemaEntry(dir: string): boolean {
  return existsSync(join(dir, 'dist', 'index.d.ts')) || existsSync(join(dir, 'src', 'index.ts'));
}

/**
 * Walk up from this module to the directory holding `@coredoc/profile-parser`'s own package.json.
 * Works from `src/` (tsx/dev) and `dist/` (built) alike.
 *
 * The manifest's `name` is checked rather than taking the first package.json found: bundlers emit
 * stub manifests (electron-vite writes `dist/main/package.json` = `{"type":"commonjs"}`) that would
 * otherwise be accepted as this package's root, yielding a confident-looking path that holds no
 * schema at all. Returns null when no such package exists — a bundled engine is the normal case,
 * and the env override answers it.
 */
function packageRoot(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 10; depth++) {
    const manifest = join(dir, 'package.json');
    if (existsSync(manifest)) {
      try {
        const name = JSON.parse(readFileSync(manifest, 'utf8'))?.name;
        if (name === '@coredoc/profile-parser') return dir;
      } catch {
        /* unreadable/…malformed manifest — keep walking */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** The schema root to compile profiles against: explicit override first, own package second. */
function schemaRoot(): string {
  const override = process.env[SCHEMA_DIR_ENV]?.trim();
  if (override) {
    if (!hasSchemaEntry(override)) {
      throw new Error(
        `${SCHEMA_DIR_ENV} is set to ${override}, but neither dist/index.d.ts nor src/index.ts exists there. ` +
          'Point it at a @coredoc/profile-parser package directory that carries its type declarations.',
      );
    }
    return override;
  }

  const own = packageRoot();
  if (!own) {
    throw new Error(
      'Cannot typecheck profiles: the @coredoc/profile-parser package root is not on disk next to this ' +
        `module (it is running from a bundle). Set ${SCHEMA_DIR_ENV} to a copy of the package that ships ` +
        'its dist/index.d.ts.',
    );
  }
  return own;
}

/**
 * The module that declares `ExtractionProfile` and friends.
 *
 * Preference follows *this module's own* location rather than a fixed order: a profile
 * must be checked against the schema the running engine actually applies. Validating a
 * tsx/source run against a stale built `.d.ts` would accept rules the live engine does
 * not implement — exactly the silent-hole class this gate exists to close.
 */
function schemaEntry(root: string): string {
  const builtEntry = join(root, 'dist', 'index.d.ts');
  const sourceEntry = join(root, 'src', 'index.ts');
  const runningFromDist = fileURLToPath(import.meta.url).includes(`${sep}dist${sep}`);
  const ordered = runningFromDist ? [builtEntry, sourceEntry] : [sourceEntry, builtEntry];
  const found = ordered.find((p) => existsSync(p));
  if (!found) {
    throw new Error(
      `Cannot typecheck profiles: neither dist/index.d.ts nor src/index.ts exists under ${root}. ` +
        `Build @coredoc/profile-parser (pnpm build), run from a source checkout, or set ${SCHEMA_DIR_ENV} ` +
        'to a package copy that ships its type declarations.',
    );
  }
  return found;
}

/** The single lib the gate compiles against; also what proves a candidate lib dir is real. */
const PROFILE_LIB = 'lib.es2022.d.ts';

/**
 * Directory holding TypeScript's own `lib.*.d.ts` files.
 *
 * TypeScript looks for them next to the module it was loaded from, which breaks for a host that
 * BUNDLES the engine: the location resolves into the bundle, where no lib files exist. A program
 * without a lib does not fail loudly — the global `Array` type is missing, so `CustomRule[]`
 * degrades to an error type, the object literal loses its contextual type, and the profile's own
 * `run: (facts, emit) => …` parameters get reported as implicitly `any` (TS7006). The profile is
 * fine; the compiler was crippled. So resolve the lib from the schema package instead, which sits
 * in a real node_modules tree next to a real `typescript`.
 */
function typeScriptLibDir(schemaRootDir: string): string | null {
  const candidates: string[] = [];
  try {
    candidates.push(dirname(ts.getDefaultLibFilePath({})));
  } catch {
    /* ts.sys unavailable — the schema-relative lookup below is the answer */
  }
  try {
    const requireFromSchema = createRequire(join(schemaRootDir, 'package.json'));
    candidates.push(join(dirname(requireFromSchema.resolve('typescript/package.json')), 'lib'));
  } catch {
    /* no resolvable typescript next to the schema */
  }
  return candidates.find((dir) => existsSync(join(dir, PROFILE_LIB))) ?? null;
}

/**
 * Profiles are data modules, not application code: no ambient @types, no DOM. Keeping
 * `types: []` means a profile never needs `@types/node` installed next to it — profile
 * storage lives outside any node_modules tree in production.
 */
function compilerOptions(schemaModule: string): ts.CompilerOptions {
  return {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: [PROFILE_LIB],
    types: [],
    strict: true,
    esModuleInterop: true,
    skipLibCheck: true,
    noEmit: true,
    // Profile storage sits outside any node_modules tree, so the bare specifier a
    // profile imports cannot be resolved by node resolution — map it explicitly.
    paths: { '@coredoc/profile-parser': [schemaModule] },
  };
}

/**
 * Module-resolution errors, which this gate must NOT fail on.
 *
 * A profile lives in the user's parser storage (`<workspace>/coredoc-parsers/<proj>/<repo>/`),
 * not inside a checkout of this engine, so the relative specifier the archetypes ship
 * (`'../../../packages/profile-parser/src/types.js'`) cannot resolve there. That is a
 * packaging fact about where the file sits, not a claim about the profile's shape — failing
 * on it would abort `coredoc parse` for every profile authored the documented way. The
 * schema check still happens: the `paths` mapping resolves the bare `@coredoc/profile-parser`
 * specifier, and an unresolved import degrades its type to `any`, which weakens the check
 * rather than breaking the run.
 */
const RESOLUTION_ERROR_CODES = new Set([
  2307, // Cannot find module '…' or its corresponding type declarations.
  2306, // File '…' is not a module.
  2792, // Cannot find module. Did you mean to set 'moduleResolution' to 'node'?
]);

const AMBIENT_RUNTIME_GLOBALS = new Set([
  'process',
  'global',
  'globalThis',
  'require',
  'module',
  'exports',
  '__dirname',
  '__filename',
  'Bun',
  'Deno',
]);

const DYNAMIC_CODE_GLOBALS = new Set(['eval', 'Function']);

const PROTOTYPE_CAPABILITY_PROPERTIES = new Set(['constructor', 'prototype', '__proto__']);

function staticStringValue(expression: ts.Expression): string | null {
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return expression.text;
  }
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isNonNullExpression(expression) ||
    ts.isSatisfiesExpression(expression)
  ) {
    return staticStringValue(expression.expression);
  }
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticStringValue(expression.left);
    const right = staticStringValue(expression.right);
    return left === null || right === null ? null : left + right;
  }
  return null;
}

function accessedPropertyName(node: ts.PropertyAccessExpression | ts.ElementAccessExpression): string | null {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  return node.argumentExpression ? staticStringValue(node.argumentExpression) : null;
}

function declaredBindingPropertyName(node: ts.BindingElement): string | null {
  if (!ts.isObjectBindingPattern(node.parent)) return null;
  const propertyName = node.propertyName;
  if (!propertyName) return ts.isIdentifier(node.name) ? node.name.text : null;
  if (
    ts.isIdentifier(propertyName) ||
    ts.isStringLiteral(propertyName) ||
    ts.isNumericLiteral(propertyName) ||
    ts.isNoSubstitutionTemplateLiteral(propertyName)
  ) {
    return propertyName.text;
  }
  return ts.isComputedPropertyName(propertyName) ? staticStringValue(propertyName.expression) : null;
}

function reflectivelyReadPropertyName(node: ts.CallExpression): string | null {
  if (!ts.isPropertyAccessExpression(node.expression) && !ts.isElementAccessExpression(node.expression)) return null;
  const owner = node.expression.expression;
  if (!ts.isIdentifier(owner)) return null;
  const method = accessedPropertyName(node.expression);
  const readsProperty =
    (owner.text === 'Reflect' && (method === 'get' || method === 'getOwnPropertyDescriptor')) ||
    (owner.text === 'Object' && method === 'getOwnPropertyDescriptor');
  if (!readsProperty) return null;
  return node.arguments[1] ? staticStringValue(node.arguments[1]) : null;
}

function runtimeImport(statement: ts.ImportDeclaration): boolean {
  const clause = statement.importClause;
  if (!clause) return true;
  if (clause.isTypeOnly) return false;
  const bindings = clause.namedBindings;
  return !(
    !clause.name &&
    bindings !== undefined &&
    ts.isNamedImports(bindings) &&
    bindings.elements.length > 0 &&
    bindings.elements.every((element) => element.isTypeOnly)
  );
}

function declaredTopLevelNames(source: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text);
    }
  }
  return names;
}

function assignmentRoot(expression: ts.Expression): ts.Identifier | null {
  let current = expression;
  while (true) {
    if (ts.isIdentifier(current)) return current;
    if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
      current = current.expression;
      continue;
    }
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isSatisfiesExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    return null;
  }
}

function isAllowedProfileAssembly(statement: ts.ExpressionStatement, topLevelNames: Set<string>): boolean {
  const expression = statement.expression;
  if (!ts.isBinaryExpression(expression) || expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return false;
  const root = assignmentRoot(expression.left);
  return root !== null && topLevelNames.has(root.text);
}

function isIdentifierReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return true;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (
    (ts.isPropertyAssignment(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isMethodSignature(parent)) &&
    parent.name === node &&
    !parent.name.getText().startsWith('[')
  ) {
    return false;
  }
  if (
    (ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isBindingElement(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isClassExpression(parent) ||
      ts.isInterfaceDeclaration(parent) ||
      ts.isTypeAliasDeclaration(parent) ||
      ts.isTypeParameterDeclaration(parent) ||
      ts.isImportClause(parent) ||
      ts.isImportSpecifier(parent) ||
      ts.isNamespaceImport(parent)) &&
    parent.name === node
  ) {
    return false;
  }
  return true;
}

function isPermittedTopLevelStatement(statement: ts.Statement, topLevelNames: Set<string>): boolean {
  if (ts.isImportDeclaration(statement)) return true;
  if (ts.isImportEqualsDeclaration(statement)) return true;
  if (ts.isVariableStatement(statement)) return (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;
  if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) return true;
  // A helper used by a custom rule is inert until the engine invokes the rule. Its body is still
  // traversed below, so it receives the same ambient-capability restrictions as an inline rule.
  if (ts.isFunctionDeclaration(statement)) return true;
  if (ts.isExportAssignment(statement) || ts.isExportDeclaration(statement) || ts.isEmptyStatement(statement)) {
    return true;
  }
  if (ts.isExpressionStatement(statement)) return isAllowedProfileAssembly(statement, topLevelNames);
  return false;
}

/**
 * Inspect the entire module before it can be imported. Custom-rule callbacks are executable by
 * design, but their capability surface is facts + emit: ambient runtimes, module loading, dynamic
 * code, and module-initialization side effects are outside that contract.
 */
export function profileCapabilityViolations(profilePath: string): ProfileCapabilityViolation[] {
  const absolute = resolve(profilePath);
  if (!existsSync(absolute)) throw new Error(`Profile not found: ${absolute}`);
  const source = ts.createSourceFile(
    absolute,
    readFileSync(absolute, 'utf8'),
    ts.ScriptTarget.ES2022,
    true,
    absolute.endsWith('.js') || absolute.endsWith('.mjs') || absolute.endsWith('.cjs')
      ? ts.ScriptKind.JS
      : ts.ScriptKind.TS,
  );
  const violations: ProfileCapabilityViolation[] = [];
  const seen = new Set<string>();
  const add = (node: ts.Node, message: string): void => {
    const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
    const key = `${node.getStart(source)}:${message}`;
    if (seen.has(key)) return;
    seen.add(key);
    violations.push({ file: absolute, line: line + 1, column: character + 1, message });
  };

  const topLevelNames = declaredTopLevelNames(source);
  for (const statement of source.statements) {
    if (ts.isImportEqualsDeclaration(statement)) {
      add(statement, 'Runtime import-equals declarations are not allowed.');
    } else if (ts.isImportDeclaration(statement) && runtimeImport(statement)) {
      add(statement, 'Runtime imports are not allowed; import profile schema names with `import type`.');
    } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier) {
      add(statement, 'Re-export module specifiers are not allowed in a declarative profile.');
    }
    if (!isPermittedTopLevelStatement(statement, topLevelNames)) {
      add(statement, `Top-level ${ts.SyntaxKind[statement.kind]} is not allowed in a declarative profile.`);
    }
  }

  const visit = (node: ts.Node, functionDepth: number): void => {
    const nextFunctionDepth = ts.isFunctionLike(node) ? functionDepth + 1 : functionDepth;

    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const propertyName = accessedPropertyName(node);
      if (propertyName !== null && PROTOTYPE_CAPABILITY_PROPERTIES.has(propertyName)) {
        add(node, `Prototype capability property '${propertyName}' is not allowed in a declarative profile.`);
      }
    } else if (ts.isBindingElement(node)) {
      const propertyName = declaredBindingPropertyName(node);
      if (propertyName !== null && PROTOTYPE_CAPABILITY_PROPERTIES.has(propertyName)) {
        add(node, `Prototype capability property '${propertyName}' is not allowed in a declarative profile.`);
      }
    }

    if (ts.isCallExpression(node)) {
      const reflectedPropertyName = reflectivelyReadPropertyName(node);
      if (reflectedPropertyName !== null && PROTOTYPE_CAPABILITY_PROPERTIES.has(reflectedPropertyName)) {
        add(node, `Prototype capability property '${reflectedPropertyName}' is not allowed in a declarative profile.`);
      }
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        add(node, 'Dynamic import() is not allowed in a declarative profile.');
      } else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
        add(node, 'require() is not allowed in a declarative profile.');
      } else if (ts.isIdentifier(node.expression) && node.expression.text === 'eval') {
        add(node, 'eval() is not allowed in a declarative profile.');
      } else if (ts.isIdentifier(node.expression) && node.expression.text === 'Function') {
        add(node, 'The Function constructor is not allowed in a declarative profile.');
      } else if (functionDepth === 0) {
        add(node, 'A top-level call would execute while the profile module is imported.');
      }
    } else if (ts.isNewExpression(node)) {
      if (ts.isIdentifier(node.expression) && node.expression.text === 'Function') {
        add(node, 'The Function constructor is not allowed in a declarative profile.');
      } else if (functionDepth === 0) {
        add(node, 'A top-level constructor call would execute while the profile module is imported.');
      }
    } else if (
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node) ||
      ts.isClassExpression(node) ||
      ts.isClassStaticBlockDeclaration(node)
    ) {
      add(node, 'Accessors and class evaluation are not part of the declarative profile grammar.');
    } else if (
      functionDepth === 0 &&
      (ts.isAwaitExpression(node) ||
        ts.isYieldExpression(node) ||
        ts.isTaggedTemplateExpression(node) ||
        ts.isDeleteExpression(node) ||
        ts.isPostfixUnaryExpression(node) ||
        (ts.isPrefixUnaryExpression(node) &&
          (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)))
    ) {
      add(node, 'This top-level expression would execute while the profile module is imported.');
    }

    if (ts.isIdentifier(node) && isIdentifierReference(node)) {
      if (AMBIENT_RUNTIME_GLOBALS.has(node.text)) {
        add(node, `Ambient runtime global '${node.text}' is not available to declarative profiles.`);
      } else if (DYNAMIC_CODE_GLOBALS.has(node.text)) {
        add(
          node,
          `${node.text === 'Function' ? 'The Function constructor' : 'eval'} is not allowed in a declarative profile.`,
        );
      }
    }

    ts.forEachChild(node, (child) => visit(child, nextFunctionDepth));
  };
  visit(source, 0);
  return violations;
}

function toDiagnostic(d: ts.Diagnostic): ProfileDiagnostic | null {
  if (!d.file || d.start === undefined) return null;
  const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
  return {
    file: d.file.fileName,
    line: line + 1,
    column: character + 1,
    code: d.code,
    message: ts.flattenDiagnosticMessageText(d.messageText, ' '),
  };
}

/**
 * Semantically check one profile module. Returns the errors found *in that file*;
 * an empty array means the profile matches the schema it is typed against.
 */
export function typecheckProfile(profilePath: string): ProfileDiagnostic[] {
  const absolute = resolve(profilePath);
  if (!existsSync(absolute)) {
    throw new Error(`Profile not found: ${absolute}`);
  }
  const root = schemaRoot();
  const options = compilerOptions(schemaEntry(root));

  // A missing lib yields plausible-looking errors in a correct profile, so refuse to report at
  // all rather than report noise — an unusable gate is recoverable, a lying one is not.
  const libDir = typeScriptLibDir(root);
  if (!libDir) {
    throw new Error(
      `Cannot typecheck profiles: TypeScript's ${PROFILE_LIB} was not found next to the compiler or ` +
        `under ${root}. Install typescript alongside @coredoc/profile-parser, or point ${SCHEMA_DIR_ENV} ` +
        'at a package copy that has one.',
    );
  }
  const host = ts.createCompilerHost(options);
  host.getDefaultLibLocation = () => libDir;
  host.getDefaultLibFileName = (o) => join(libDir, ts.getDefaultLibFileName(o));

  const program = ts.createProgram([absolute], options, host);
  const source = program.getSourceFile(absolute);
  if (!source) {
    throw new Error(`TypeScript could not load the profile source: ${absolute}`);
  }
  return [...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source)]
    .filter((d) => !RESOLUTION_ERROR_CODES.has(d.code))
    .map(toDiagnostic)
    .filter((d): d is ProfileDiagnostic => d !== null);
}

/** Render diagnostics as an actionable, copy-pasteable error body. */
export function formatProfileDiagnostics(profilePath: string, diagnostics: ProfileDiagnostic[]): string {
  const lines = diagnostics.map((d) => `  ${profilePath}:${d.line}:${d.column}  TS${d.code}: ${d.message}`);
  return (
    `Profile does not match the ExtractionProfile schema (${diagnostics.length} error${
      diagnostics.length === 1 ? '' : 's'
    }):\n${lines.join('\n')}\n\n` +
    'A profile that does not typecheck loads but silently extracts nothing for the ' +
    'offending rules. Fix the profile, or run the author-profile loop to regenerate it.'
  );
}

/** Render capability violations as an actionable error body. */
export function formatProfileCapabilityViolations(
  profilePath: string,
  violations: ProfileCapabilityViolation[],
): string {
  const lines = violations.map(
    (violation) => `  ${profilePath}:${violation.line}:${violation.column}  ${violation.message}`,
  );
  return (
    `Profile is not declarative (${violations.length} executable capability violation${
      violations.length === 1 ? '' : 's'
    }):\n${lines.join('\n')}\n\n` +
    'Profiles may declare data and facts-only custom rules, but may not load runtime modules, use ambient ' +
    'process globals, evaluate dynamic code, or execute side effects while the module is imported.'
  );
}

/**
 * Gate: throw unless the profile matches the schema. Called on the load path so a
 * structurally dead rule fails the parse instead of quietly emitting zero nodes.
 *
 * A compiled `.js` profile carries no type information, so only its capability grammar is
 * checked. That is safe because the `.js` is otherwise produced by transpiling a `.ts` that
 * this gate already accepted.
 */
export function assertProfileTypechecks(profilePath: string): void {
  const violations = profileCapabilityViolations(profilePath);
  if (violations.length > 0) {
    throw new ProfileCapabilityError(profilePath, violations);
  }
  if (!profilePath.endsWith('.ts')) return;
  const diagnostics = typecheckProfile(profilePath);
  if (diagnostics.length > 0) {
    throw new ProfileTypeError(profilePath, diagnostics);
  }
}
