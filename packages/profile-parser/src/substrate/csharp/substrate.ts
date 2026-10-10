import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { StableIdGenerator } from '@coredoc/core';
import { TreeSitterLoader } from '../../tree-sitter/tree-sitter-loader.js';
import type { AnalysisRecord, ParsedRepo, ParseError, TypeInfo, Visibility } from '@coredoc/core/types';
import { CodeGraph } from '../../facts/graph/graph-builder.js';
import { enumerateRepoFiles } from '../../facts/discovery/discover.js';
import type { ParseOptions } from '../../providers/types.js';
import type { CSharpProfile } from '../../types/csharp-profile.js';
import type { CallEdgeFact } from '../interface.js';
import type { NominalTypeFact, NominalAttributeFact, NominalCallFact, NominalValueFact } from './model.js';
import { applySourceFileScope } from '../source-file-scope.js';
import { nominalEntrypoints, nominalModels } from './nominal.js';
import { nominalExternalCalls } from './nominal-egress.js';
import { nominalDispatch } from './nominal-dispatch.js';
import type { Attribute, Expression, Invocation, Project, TypeDeclaration } from './model.js';
import { owningProject, readProjects } from './projects.js';
import { CSharpResolver, typeArguments } from './resolve.js';
import { extractFile, stringValue, type Construction } from './syntax.js';
import { preprocess } from './preprocess.js';
import type { LoadedScip } from '../../facts/scip/decode.js';
import { CSharpSemanticIndex } from './semantic.js';
import { getCSharpIndexHost } from './desktop.js';
import { readCSharpIndex, prepareCSharpIndex } from './scip-run.js';
import { CSharpReceiverTypes, type CSharpReceiverType } from './receiver-types.js';

const defaults = ['**/bin/**', '**/obj/**', '**/*.g.cs', '**/*.generated.cs'];
export function csharpFileScope(root: string, profile: CSharpProfile) {
  return applySourceFileScope(
    enumerateRepoFiles(root).filter((f) => f.endsWith('.cs')),
    profile.substrate.include,
    defaults,
    profile.substrate.exclude,
  );
}
const visibility = (mods: string[]): Visibility =>
  mods.includes('public')
    ? 'public'
    : mods.includes('protected')
      ? 'protected'
      : mods.includes('internal')
        ? 'internal'
        : 'private';
export class CSharpSubstrate {
  readonly analysis: AnalysisRecord = {
    language: 'csharp',
    mode: 'basic',
    compilerReceiverTypes: false,
    fallback: false,
  };
  readonly graph = new CodeGraph();
  readonly errors: ParseError[] = [];
  readonly idGen: StableIdGenerator;
  readonly declarations: TypeDeclaration[] = [];
  readonly invocations: Invocation[] = [];
  readonly constructions: Construction[] = [];
  readonly projects: Project[] = [];
  readonly sourceHashes = new Map<string, string>();
  resolver!: CSharpResolver;
  private calls: CallEdgeFact[] = [];
  private methodImplementations = new Map<string, Set<string>>();
  private receiverTypes = new CSharpReceiverTypes([]);
  readonly outOfScopeCalls = new Set<string>();
  sourceFileCount = 0;
  private constructor(
    readonly profile: CSharpProfile,
    readonly opts: ParseOptions,
  ) {
    this.idGen = new StableIdGenerator(opts.repoRoot, opts.repoKey ?? opts.repoName);
  }
  static async create(profile: CSharpProfile, opts: ParseOptions): Promise<CSharpSubstrate> {
    const substrate = new CSharpSubstrate(profile, opts);
    const files = enumerateRepoFiles(opts.repoRoot);
    substrate.projects.push(...readProjects(opts.repoRoot, files));
    const scope = applySourceFileScope(
      files.filter((f) => f.endsWith('.cs')),
      profile.substrate.include,
      defaults,
      profile.substrate.exclude,
    );
    substrate.sourceFileCount = scope.included.length;
    // The loader owns this Parser for the life of the process; only the trees below are ours to free.
    const parser = await TreeSitterLoader.getInstance().getParser('csharp');
    for (const file of scope.included) {
      try {
        const owner = owningProject(file, substrate.projects);
        if (!owner) {
          const hasCandidate = substrate.projects.some(
            (p) => p.directory === '.' || file.startsWith(`${p.directory}/`),
          );
          substrate.errors.push({
            file,
            severity: hasCandidate ? 'error' : 'warning',
            message: hasCandidate
              ? 'C# source has ambiguous .csproj ownership.'
              : 'Loose C# source excluded: no owning .csproj.',
          });
          continue;
        }
        const bytes = readFileSync(join(opts.repoRoot, file));
        const source = bytes.toString('utf8');
        substrate.sourceHashes.set(file, createHash('sha256').update(bytes).digest('hex'));
        // Roslyn's SourceText excludes the UTF-8 BOM. Use the same character
        // coordinates for CST/receiver joins while hashing the untouched file.
        const syntaxSource = source.replace(/^\uFEFF/, '');
        const parseSource = preprocess(syntaxSource, profile.substrate.defines ?? []);
        const tree = parser.parse(parseSource);
        try {
          if (tree.rootNode.hasError)
            substrate.errors.push({
              file,
              severity: 'error',
              message: 'C# syntax contains unsupported or invalid syntax; dependent facts are omitted.',
            });
          const facts = extractFile(tree.rootNode, file, owner.path, syntaxSource);
          substrate.declarations.push(...facts.types);
          substrate.invocations.push(...facts.invocations);
          substrate.constructions.push(...facts.constructions);
          owner.globalUsings.push(...facts.globalUsings);
          const hash = substrate.idGen.contentHash(source);
          substrate.graph.addFile({
            id: substrate.idGen.fileId(file),
            versionedId: substrate.idGen.versionedFileId(file, hash),
            path: file,
            extension: '.cs',
            packageId: substrate.idGen.packageId(owner.path),
            language: 'csharp',
            contentHash: hash,
            loc: source.split('\n').length,
          });
        } finally {
          tree.delete();
        }
      } catch (error) {
        substrate.errors.push({ file, severity: 'error', message: `Could not parse C# source: ${String(error)}` });
      }
    }
    substrate.mergePartials();
    substrate.resolver = new CSharpResolver(substrate.declarations, substrate.projects, profile.libraries);
    substrate.buildGraph();
    for (const site of substrate.constructions) {
      const type = substrate.resolver.resolveType(site.type, site.caller.type);
      if (!type || type.kind === 'interface_declaration' || type.kind === 'enum_declaration') continue;
      substrate.graph.addClassRef({
        id: substrate.idGen.classRefEdgeId(site.caller.id, type.name, 'construction'),
        sourceId: site.caller.id,
        refKind: 'construction',
        className: type.name,
        declaringFile: type.file,
        location: site.loc,
      });
    }
    substrate.calls = substrate.invocations.map((site) => {
      const resolved = substrate.resolver.resolveCall(site);
      const fn = site.expression.object!;
      return {
        id: substrate.idGen.callEdgeId(
          site.caller.id,
          fn.text,
          `${site.loc.filePath}:${site.loc.startLine}:${site.loc.startColumn}`,
        ),
        callerId: site.caller.id,
        calleeId: resolved?.method.id,
        provenance: resolved?.provenance,
        calleeExpression: fn.text,
        isMethodCall: fn.kind === 'member_access_expression',
        location: site.loc,
        arguments: site.expression.args?.map((a) => a.text),
      };
    });
    return substrate;
  }
  private mergePartials() {
    const groups = new Map<string, TypeDeclaration[]>();
    for (const t of this.declarations)
      groups.set(`${t.project}:${t.name}`, [...(groups.get(`${t.project}:${t.name}`) ?? []), t]);
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const first = group[0]!;
      if (!group.every((t) => t.modifiers.includes('partial') && t.kind === first.kind)) {
        this.errors.push({
          file: first.file,
          severity: 'error',
          message: `Conflicting declarations for ${first.name}.`,
        });
        continue;
      }
      for (const part of group.slice(1)) {
        first.methods.push(...part.methods);
        first.properties.push(...part.properties);
        first.attributes.push(...part.attributes);
        first.bases = [...new Set([...first.bases, ...part.bases])];
        if (part.primaryParameters.length) first.primaryParameters = part.primaryParameters;
        this.declarations.splice(this.declarations.indexOf(part), 1);
        // Each method keeps its original file/usings for lexical resolution, and
        // gets the shared declaration's member set for calls across partial files.
        part.methods = first.methods;
        part.properties = first.properties;
        part.bases = first.bases;
      }
    }
  }
  setReceiverTypes(facts: CSharpReceiverType[]): void {
    this.receiverTypes = new CSharpReceiverTypes(facts);
  }
  applySemanticIndex(index: LoadedScip): void {
    const semantic = new CSharpSemanticIndex(index, this.declarations);
    for (const type of this.declarations) {
      if (type.nameRange && !semantic.declaredTypes.has(type.id))
        throw new Error(
          `C# declaration ${type.name} is absent from the compiler index; check the profile's conditional defines and project scope.`,
        );
    }
    for (const file of new Set(this.declarations.map((t) => t.file))) {
      if (!semantic.files.has(file))
        throw new Error(`C# source declarations are missing from the semantic index: ${file}.`);
    }
    this.methodImplementations = semantic.methodImplementations;
    this.calls = this.calls.map((call, i) => {
      const site = this.invocations[i]!;
      const method = semantic.resolveCall(site);
      if (semantic.isOutOfScope(site)) this.outOfScopeCalls.add(call.id);
      // No compiler occurrence leaves lexical evidence intact. An external,
      // excluded or ambiguous compiler reference must not revive a guessed edge.
      if (!method && !semantic.hasReference(site)) return call;
      return { ...call, calleeId: method?.id, provenance: method ? 'scip' : undefined };
    });
  }
  private buildGraph() {
    const id = this.idGen;
    const g = this.graph;
    for (const project of this.projects) {
      if ([...g.files.values()].some((f) => f.packageId === id.packageId(project.path)))
        g.addPackage({
          id: id.packageId(project.path),
          name: project.name,
          path: project.directory,
          manifestFile: project.path,
          language: 'csharp',
          dependencies: project.dependencies,
        });
    }
    // Assign all type IDs before resolving any heritage reference.
    for (const t of this.declarations)
      t.id =
        t.kind === 'interface_declaration'
          ? id.interfaceId(t.file, t.name)
          : t.kind === 'enum_declaration'
            ? id.enumId(t.file, t.name)
            : id.classId(t.file, t.name);
    for (const t of this.declarations) {
      const base = {
        id: t.id,
        versionedId: id.versionedId(t.id, t.source),
        name: t.name,
        fileId: id.fileId(t.file),
        location: t.loc,
        sourceCode: t.source,
        isExported: t.modifiers.includes('public'),
      };
      const refs = t.bases.map((name) => ({ name, resolvedId: this.resolver.resolveType(name, t)?.id }));
      for (const m of t.methods) {
        m.type.id = t.id;
        m.id = id.methodId(m.loc.filePath, t.name, m.signature);
        g.addFunction({
          id: m.id,
          versionedId: id.versionedId(m.id, m.source),
          name: `${t.name}.${m.signature}`,
          location: m.loc,
          sourceCode: m.source,
          kind: t.kind === 'interface_declaration' ? 'function' : 'method',
          classId: t.kind === 'interface_declaration' ? undefined : t.id,
          fileId: id.fileId(m.loc.filePath),
          isAsync: m.modifiers.includes('async'),
          isGenerator: false,
          parameters: m.parameters.map((p) => ({ ...p, type: this.typeInfo(p.type?.text, m.type) })),
          returnType: this.typeInfo(m.returnType, m.type),
          visibility: visibility(m.modifiers),
          isStatic: m.modifiers.includes('static'),
          isAbstract: m.modifiers.includes('abstract'),
        });
      }
      const constructors = t.methods.filter((m) => m.name === '.ctor');
      const singleConstructor = constructors.length === 1 ? constructors[0] : undefined;
      if (t.kind === 'interface_declaration')
        g.addInterface({
          ...base,
          kind: 'interface',
          extends: refs,
          members: [
            ...t.methods.map((m) => ({
              name: m.name,
              kind: 'method' as const,
              isOptional: false,
              isReadonly: false,
              parameters: m.parameters.map((p) => ({ ...p, type: this.typeInfo(p.type?.text, m.type) })),
              returnType: this.typeInfo(m.returnType, m.type),
              location: m.loc,
            })),
            ...t.properties.map((p) => ({
              name: p.name,
              kind: 'property' as const,
              isOptional: false,
              isReadonly: false,
              type: this.typeInfo(p.type, t),
              location: p.loc,
            })),
          ],
        });
      else if (t.kind === 'enum_declaration')
        g.addEnum({ ...base, kind: 'enum', isConst: false, members: t.enumMembers });
      else
        g.addClass({
          ...base,
          kind: 'class',
          constructor: singleConstructor
            ? {
                id: singleConstructor.id,
                classId: t.id,
                parameters: singleConstructor.parameters.map((p) => ({
                  ...p,
                  type: this.typeInfo(p.type?.text, singleConstructor.type),
                })),
                visibility: visibility(singleConstructor.modifiers),
                location: singleConstructor.loc,
              }
            : undefined,
          isAbstract: t.modifiers.includes('abstract'),
          extends: refs.find((ref) =>
            ['class_declaration', 'record_declaration'].includes(this.resolver.resolveType(ref.name, t)?.kind ?? ''),
          ),
          implements: refs.filter((ref) => this.resolver.resolveType(ref.name, t)?.kind === 'interface_declaration'),
          methods: t.methods.map((m) => m.id),
          properties: t.properties.map((p) => ({
            id: id.variableId(p.loc.filePath, `${t.name}.${p.name}`),
            name: p.name,
            classId: t.id,
            visibility: visibility(p.modifiers),
            isStatic: p.modifiers.includes('static'),
            isReadonly: p.modifiers.includes('readonly') || p.modifiers.includes('const'),
            isOptional: false,
            type: this.typeInfo(p.type, t),
            defaultValue: p.value?.text,
            location: p.loc,
          })),
        });
    }
  }
  private typeInfo(text: string | undefined, context: TypeDeclaration): TypeInfo | undefined {
    if (!text) return undefined;
    const type = text.replace(/\?$/, '');
    if (type.endsWith('[]'))
      return { text, structure: { kind: 'array', elementType: this.typeInfo(type.slice(0, -2), context)! } };
    const name = this.resolver.identity(type, context);
    if (!name) {
      // An unresolved C# name must not fall through to downstream bare-name matching
      // against an unrelated declaration in another namespace or project.
      return { text, structure: { kind: 'unknown' } };
    }
    const args = typeArguments(type).map((arg) => this.typeInfo(arg, context)!);
    return { text, structure: { kind: 'reference', name, ...(args.length ? { typeArguments: args } : {}) } };
  }
  nominalTypes(): NominalTypeFact[] {
    const attributes = (attrs: Attribute[], context: TypeDeclaration): NominalAttributeFact[] =>
      attrs.map((a) => ({
        type: this.resolver.identity(a.name, context, true),
        args: a.args.map((arg) => ({ text: arg.text, name: arg.name, value: this.constantValue(arg.text, context) })),
      }));
    return this.declarations.map((t) => ({
      id: t.id,
      name: t.name,
      simpleName: t.simpleName,
      abstract: t.modifiers.includes('abstract'),
      baseTypes: t.bases.flatMap((base) => {
        const name = this.resolver.identity(base, t);
        return name ? [name] : [];
      }),
      attributes: attributes(t.attributes, t),
      location: t.loc,
      methods: t.methods.map((m) => ({
        id: m.id,
        name: m.name,
        signature: m.signature,
        public: m.modifiers.includes('public'),
        static: m.modifiers.includes('static'),
        abstract: m.modifiers.includes('abstract'),
        isConstructor: m.name === '.ctor',
        implements: [...(this.methodImplementations.get(m.id) ?? [])],
        attributes: attributes(m.attributes, m.type),
        location: m.loc,
      })),
      properties: t.properties.map((p) => ({
        name: p.name,
        typeText: p.type,
        type: p.type ? this.resolver.identity(p.type, t) : undefined,
        typeArguments: typeArguments(p.type ?? '').map((a) => this.resolver.identity(a, t)),
        public: p.modifiers.includes('public'),
        static: p.modifiers.includes('static') || p.modifiers.includes('const'),
        nullable: p.type?.endsWith('?') ?? false,
        attributes: attributes(p.attributes, t),
        location: p.loc,
      })),
    }));
  }
  private constantValue(text: string, context: TypeDeclaration): string | undefined {
    const literal = stringValue(text);
    if (literal !== undefined) return literal;
    const pieces = text.split('.');
    const member = pieces.pop();
    const type = pieces.length ? this.resolver.resolveType(pieces.join('.'), context) : context;
    const candidates = type?.properties.filter((p) => p.name === member && p.modifiers.includes('const')) ?? [];
    return candidates.length === 1 ? stringValue(candidates[0]!.value?.text ?? '') : undefined;
  }
  nominalCalls(): NominalCallFact[] {
    return this.invocations.map((site, index) => {
      const convert = (expr: Expression, at = site, depth = 0): NominalValueFact => {
        if (depth > 12) return { text: expr.text };
        const context = at.caller.type;
        const inferred = this.resolver.expressionType(expr, at);
        const compilerType = this.receiverTypes.get(at.loc.filePath, expr);
        const fn = expr.kind === 'invocation_expression' ? expr.object : expr;
        const value: NominalValueFact = {
          text: expr.text,
          value: stringValue(expr.text),
          type:
            compilerType !== undefined
              ? (compilerType?.type ?? undefined)
              : inferred
                ? this.resolver.identity(inferred, context)
                : undefined,
          typeArguments:
            compilerType !== undefined
              ? (compilerType?.typeArguments ?? [])
              : typeArguments(inferred ?? '').map((a) => this.resolver.identity(a, context)),
        };
        if (expr.kind === 'identifier') {
          value.parameter = this.resolver.parameterBinding(expr.text, at);
          const binding = this.resolver.bindingInitializer(expr.text, at);
          if (binding) {
            value.initializer = convert(binding.value, binding.site, depth + 1);
            value.value ??= value.initializer.value;
          }
        }
        if (fn?.kind === 'member_access_expression') {
          value.member = fn.name;
          if (fn.object) value.receiver = convert(fn.object, at, depth + 1);
        } else if (fn?.kind === 'generic_name' || fn?.kind === 'identifier') value.member = fn.name;
        if (fn?.typeArgs) value.typeArguments = fn.typeArgs.map((a) => this.resolver.identity(a, context));
        if (expr.args && expr.kind === 'invocation_expression')
          value.args = expr.args.map((arg) => convert(arg, at, depth + 1));
        if (expr.kind === 'lambda_expression') {
          const lambda = context.methods.find((m) => m.start === expr.start && m.end === expr.end);
          value.functionId = lambda?.id;
          if (expr.object?.kind === 'member_access_expression' && expr.object.object?.kind === 'identifier') {
            const parameter = lambda?.bindings.find((b) => b.parameterIndex === 0);
            if (parameter?.name === expr.object.object.text) value.lambdaMember = expr.object.name;
          }
        } else if (expr.kind === 'identifier' && !this.resolver.hasValueBinding(expr.text, at)) {
          const methods = this.resolver.methods(context, expr.text);
          if (methods.length === 1) value.functionId = methods[0]?.id;
        }
        return value;
      };
      return {
        ...convert(site.expression),
        id: this.calls[index]!.id,
        callerId: site.caller.id,
        calleeId: this.calls[index]?.calleeId,
        location: site.loc,
      };
    });
  }
  internalCalls() {
    return this.calls;
  }
}

interface CSharpParseOptions extends ParseOptions {
  /** A precomputed compiler index, validated against the input bytes before use. */
  preparedCSharpIndex?: string;
}

export async function parseCSharp(profile: CSharpProfile, opts: CSharpParseOptions) {
  const start = performance.now();
  const substrate = await CSharpSubstrate.create(profile, opts);
  const projects = profile.substrate.projects ?? [...new Set(substrate.declarations.map((t) => t.project))];
  // Authoring stays basic; a desktop parse with a host bridge can prepare compiler facts.
  const indexHost = getCSharpIndexHost();
  const mode =
    profile.substrate.analysis?.mode ?? (process.env.COREDOC_CSHARP_DEFAULT_MODE === 'basic' ? 'basic' : 'enhanced');
  if (mode === 'basic') console.info('[coredoc] C# analysis: basic (selected by profile or host default).');
  if (substrate.sourceFileCount > 0 && mode !== 'basic') {
    try {
      const hosted =
        indexHost && !opts.preparedCSharpIndex
          ? await indexHost({
              projects,
              defines: profile.substrate.defines ?? [],
              fallback: profile.substrate.analysis?.fallback !== false,
            })
          : undefined;
      if (hosted && 'basic' in hosted) {
        if (profile.substrate.analysis?.fallback === false)
          throw new Error('This profile requires enhanced C# analysis.');
        console.info('[coredoc] C# analysis: basic (selected in desktop).');
        return finishCSharpParse(profile, substrate, opts, start);
      }
      const preparedPath = hosted && 'path' in hosted ? hosted.path : opts.preparedCSharpIndex;
      const { index, manifest } = preparedPath
        ? readCSharpIndex(opts.repoRoot, preparedPath)
        : await prepareCSharpIndex(opts.repoRoot, projects, opts.scipOutDir, profile.substrate.defines);
      for (const [file, hash] of substrate.sourceHashes) {
        if (manifest.sourceHashes[file] !== hash)
          throw new Error(`C# source changed since semantic indexing: ${file}. Run parse again.`);
      }
      substrate.applySemanticIndex(index);
      substrate.setReceiverTypes(manifest.receiverTypes ?? []);
      substrate.analysis.mode = 'enhanced';
      substrate.analysis.compilerReceiverTypes = manifest.receiverTypes !== undefined;
      console.info(
        `[coredoc] C# analysis: enhanced (compiler calls; compiler receiver facts ${substrate.analysis.compilerReceiverTypes ? 'available' : 'unavailable'}).`,
      );
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      if (profile.substrate.analysis?.fallback === false || opts.preparedCSharpIndex) throw error;
      substrate.analysis.fallback = true;
      const message = `C# analysis: basic (enhanced unavailable: ${error instanceof Error ? error.message : String(error)}).`;
      substrate.errors.push({ file: '', severity: 'warning', message });
      console.warn(`[coredoc] ${message}`);
    }
  }
  return finishCSharpParse(profile, substrate, opts, start);
}

export function finishCSharpParse(
  profile: CSharpProfile,
  substrate: CSharpSubstrate,
  opts: ParseOptions,
  start = performance.now(),
): ParsedRepo {
  const graph = substrate.graph;
  const rules = profile.nominal ?? {};
  const types = substrate.nominalTypes();
  const sites = substrate.nominalCalls();
  const calls = nominalDispatch(rules, types, sites, substrate.internalCalls());
  const entrypoints = nominalEntrypoints(rules, types, substrate.idGen, sites);
  const externalCalls = nominalExternalCalls(rules, types, sites, substrate.idGen);
  const models = nominalModels(rules, types, sites, substrate.idGen);
  return {
    id: substrate.idGen.fileId('.').split(':')[0]!,
    name: opts.repoName,
    path: opts.repoRoot,
    type: profile.repoType,
    parsedAt: new Date().toISOString(),
    parserId: profile.parserId,
    parserVersion: '1.1.0',
    packages: [...graph.packages.values()],
    files: [...graph.files.values()],
    functions: [...graph.functions.values()],
    classes: [...graph.classes.values()],
    interfaces: [...graph.interfaces.values()],
    typeAliases: [...graph.typeAliases.values()],
    enums: [...graph.enums.values()],
    variables: [...graph.variables.values()],
    imports: [...graph.imports.values()],
    entrypoints,
    entities: models.entities,
    dbOperations: models.operations,
    calls,
    externalCalls,
    ...(graph.classRefs.size ? { classReferences: [...graph.classRefs.values()] } : {}),
    errors: substrate.errors.length ? substrate.errors : undefined,
    stats: {
      analysis: [{ ...substrate.analysis }],
      totalFiles: substrate.sourceFileCount,
      parsedFiles: graph.files.size,
      skippedFiles: substrate.sourceFileCount - graph.files.size,
      totalFunctions: graph.functions.size,
      totalClasses: graph.classes.size,
      totalEntrypoints: entrypoints.length,
      totalEntities: models.entities.length,
      totalCalls: calls.length,
      totalImports: graph.imports.size,
      totalExternalCalls: externalCalls.length,
      parseTimeMs: performance.now() - start,
      callResolution: {
        callSites: calls.length,
        resolvedCalls: calls.filter((call) => call.calleeId).length,
        outOfScopeCalls: substrate.outOfScopeCalls.size,
      },
      ...(rules.models ? { dbOpResolution: models.stats } : {}),
    },
  };
}
