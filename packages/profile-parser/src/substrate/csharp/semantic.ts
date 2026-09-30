import { decodeRange, isDefinition, type LoadedScip } from '../../facts/scip/decode.js';
import type { Invocation, Method, TypeDeclaration } from './model.js';

function key(range: number[]): string {
  const r = decodeRange(range);
  return `${r.startLine}:${r.startChar}:${r.endLine}:${r.endChar}`;
}

/** Joins exact compiler occurrences to source declarations; never interprets moniker spelling as identity. */
export class CSharpSemanticIndex {
  private references = new Map<string, Map<string, Set<string>>>();
  private definitions = new Map<string, Set<Method>>();
  private definitionPositions = new Map<string, Set<string>>();
  readonly files = new Set<string>();
  readonly declaredTypes = new Set<string>();
  readonly methodImplementations = new Map<string, Set<string>>();
  constructor(index: LoadedScip, declarations: TypeDeclaration[]) {
    const typePositions = new Map(
      declarations.filter((type) => type.nameRange).map((type) => [`${type.file}:${key(type.nameRange!)}`, type.id]),
    );
    const methods = new Map<string, Map<string, Method[]>>();
    for (const type of declarations)
      for (const method of type.methods) {
        if (!method.nameRange) continue;
        const inFile = methods.get(method.loc.filePath) ?? new Map<string, Method[]>();
        const position = key(method.nameRange);
        inFile.set(position, [...(inFile.get(position) ?? []), method]);
        methods.set(method.loc.filePath, inFile);
      }
    for (const document of index.documents) {
      const file = document.relativePath.replaceAll('\\', '/');
      if (file.startsWith('/') || file.split('/').includes('..'))
        throw new Error('C# index contains a path outside its source scope.');
      this.files.add(file);
      const references = this.references.get(file) ?? new Map<string, Set<string>>();
      this.references.set(file, references);
      for (const occurrence of document.occurrences) {
        if (!occurrence.symbol) continue;
        // SCIP local symbols have document-local identity.
        const symbol = occurrence.symbol.startsWith('local ') ? `${file}:${occurrence.symbol}` : occurrence.symbol;
        const position = key(occurrence.range);
        if (isDefinition(occurrence.symbolRoles)) {
          // Upstream can collapse distinct namespaces into one symbol. Keep excluded
          // definitions too, or narrowing profile scope would turn ambiguity into a wrong edge.
          const positions = this.definitionPositions.get(symbol) ?? new Set<string>();
          positions.add(`${file}:${position}`);
          this.definitionPositions.set(symbol, positions);
          const typeId = typePositions.get(`${file}:${position}`);
          if (typeId) this.declaredTypes.add(typeId);
          for (const method of methods.get(file)?.get(position) ?? []) {
            const definitions = this.definitions.get(symbol) ?? new Set<Method>();
            definitions.add(method);
            this.definitions.set(symbol, definitions);
          }
        } else {
          const symbols = references.get(position) ?? new Set<string>();
          symbols.add(symbol);
          references.set(position, symbols);
        }
      }
    }
    for (const document of index.documents) {
      for (const info of document.symbols ?? []) {
        const method = this.uniqueMethod(info.symbol);
        if (!method) continue;
        for (const relationship of info.relationships) {
          if (!relationship.isImplementation) continue;
          const contract = this.uniqueMethod(relationship.symbol);
          if (!contract) continue;
          const contracts = this.methodImplementations.get(method.id) ?? new Set<string>();
          contracts.add(contract.id);
          this.methodImplementations.set(method.id, contracts);
        }
      }
    }
  }
  private uniqueMethod(symbol: string): Method | undefined {
    if (this.definitionPositions.get(symbol)?.size !== 1) return undefined;
    const methods = this.definitions.get(symbol);
    return methods?.size === 1 ? [...methods][0] : undefined;
  }
  resolveCall(site: Invocation): Method | undefined {
    const range = site.expression.object?.nameRange;
    if (!range) return undefined;
    const symbols = this.references.get(site.loc.filePath)?.get(key(range));
    if (symbols?.size !== 1) return undefined;
    const symbol = [...symbols][0]!;
    if (this.definitionPositions.get(symbol)?.size !== 1) return undefined;
    const definitions = this.definitions.get(symbol);
    return definitions?.size === 1 ? [...definitions][0] : undefined;
  }

  hasReference(site: Invocation): boolean {
    const range = site.expression.object?.nameRange;
    return !!range && this.references.get(site.loc.filePath)?.has(key(range)) === true;
  }

  isOutOfScope(site: Invocation): boolean {
    const range = site.expression.object?.nameRange;
    if (!range) return false;
    const symbols = this.references.get(site.loc.filePath)?.get(key(range));
    // A compiler reference with no source method in this target is external/excluded.
    // No reference or multiple possible symbols is unresolved, never out of scope by spelling.
    if (symbols?.size !== 1) return false;
    const symbol = [...symbols][0]!;
    return (this.definitionPositions.get(symbol)?.size ?? 0) <= 1 && !this.definitions.has(symbol);
  }
}
