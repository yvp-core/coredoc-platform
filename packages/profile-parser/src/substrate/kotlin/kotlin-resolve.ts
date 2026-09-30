/**
 * Repo-wide type resolution, shared by every Kotlin lane (§Type resolution).
 *
 * The ordered rule is the whole contract: a class declared in the same FILE, then an
 * `import a.b.T` / `import a.b.*` naming an FQCN in the index, then the same Kotlin PACKAGE,
 * then a unique simple name across the repo. A name that resolves to nothing is EXTERNAL and
 * matches only where a rule says so (framework base names).
 *
 * Two included files declaring the same FQCN (flavour duplicates) both emit their nodes — ids
 * are path-keyed — but any resolution landing on that FQCN is AMBIGUOUS: the edge is dropped
 * and counted. Returning either node would be a coin flip presented as a fact.
 */
import type { KotlinFileFacts, KotlinTypeDecl } from './kotlin-declarations.js';

/** Supertype walks are bounded; a cyclic `A : B, B : A` must terminate. */
export const MAX_SUPERTYPE_HOPS = 8;

export type KotlinResolution =
  | { status: 'resolved'; decl: KotlinTypeDecl }
  | { status: 'ambiguous'; fqcn: string }
  | { status: 'external' };

export class KotlinTypeIndex {
  /** FQCN → the single declaration, for FQCNs declared exactly once. */
  private readonly byFqcn = new Map<string, KotlinTypeDecl>();
  /** FQCNs declared by more than one in-scope file. Any resolution onto these is ambiguous. */
  private readonly duplicateFqcns = new Set<string>();
  /** Simple name → every FQCN declaring it. */
  private readonly bySimpleName = new Map<string, string[]>();
  /** Kotlin package → simple name → FQCN. */
  private readonly byPackage = new Map<string, Map<string, string>>();
  /** File path → its facts, for the same-file tier. */
  private readonly byFile = new Map<string, KotlinFileFacts>();
  /**
   * `<file>#<fqcn>` → its supertype chain. The walk resolves every supertype NAME, and
   * `findMethod` runs it twice per lookup on every call site, so the uncached cost is the whole
   * index re-walked per call. The index is immutable after construction, so the chain is too.
   */
  private readonly chainCache = new Map<string, KotlinTypeDecl[]>();
  /** Supertype FQCN → the declarations reaching it, built once on the first `soleImplementation`. */
  private implementors?: Map<string, KotlinTypeDecl[]>;

  constructor(allFacts: readonly KotlinFileFacts[]) {
    for (const facts of allFacts) {
      this.byFile.set(facts.relPath, facts);
      for (const [fqcn, decl] of facts.declarations) {
        const existing = this.byFqcn.get(fqcn);
        if (existing && existing.filePath !== decl.filePath) {
          this.duplicateFqcns.add(fqcn);
        } else if (!existing) {
          this.byFqcn.set(fqcn, decl);
        }
        const simples = this.bySimpleName.get(decl.simpleName);
        if (simples) {
          if (!simples.includes(fqcn)) simples.push(fqcn);
        } else {
          this.bySimpleName.set(decl.simpleName, [fqcn]);
        }
        let pkg = this.byPackage.get(facts.packageName);
        if (!pkg) {
          pkg = new Map();
          this.byPackage.set(facts.packageName, pkg);
        }
        if (!pkg.has(decl.simpleName)) pkg.set(decl.simpleName, fqcn);
      }
    }
  }

  /** Whether an FQCN is declared by two or more in-scope files. */
  isDuplicate(fqcn: string): boolean {
    return this.duplicateFqcns.has(fqcn);
  }

  /** The declaration for an FQCN, or undefined when absent or duplicated. */
  byFullyQualifiedName(fqcn: string): KotlinTypeDecl | undefined {
    return this.duplicateFqcns.has(fqcn) ? undefined : this.byFqcn.get(fqcn);
  }

  /** Every FQCN declaring the given simple name. */
  fqcnsForSimpleName(simpleName: string): readonly string[] {
    return this.bySimpleName.get(simpleName) ?? [];
  }

  /**
   * Resolve a simple (or dotted) type name written in `file`, in the spec's order.
   *
   * `external` means "not declared in this repository" — never "unknown, pick something".
   */
  resolve(name: string, file: KotlinFileFacts): KotlinResolution {
    const simple = name.includes('.') ? (name.split('.').pop() as string) : name;

    // 0. A fully-qualified name written in full.
    if (name.includes('.')) {
      const direct = this.lookupFqcn(name);
      if (direct.status !== 'external') return direct;
    }

    // 1. A class declared in the same file (nested names qualify from the file's package).
    for (const [fqcn, decl] of file.declarations) {
      if (decl.simpleName === simple || decl.qualifiedName === name) return this.lookupFqcn(fqcn);
    }

    // 2. An explicit import, then a wildcard import.
    // An explicit import TERMINATES the lookup: it names the one FQCN this file means by that
    // name. When that FQCN is not declared here the name is EXTERNAL — falling through to the
    // same-package or unique-simple-name tier would bind `import vendor.Client` to an unrelated
    // in-repo `internal.Client`. A wildcard says only which packages to search, so a wildcard
    // that does not match keeps looking.
    for (const imp of file.imports) {
      if (imp.isWildcard) continue;
      if (imp.localName !== simple) continue;
      return this.lookupFqcn(imp.path);
    }
    for (const imp of file.imports) {
      if (!imp.isWildcard) continue;
      const base = imp.path.replace(/\.\*$/, '');
      const hit = this.lookupFqcn(`${base}.${simple}`);
      if (hit.status !== 'external') return hit;
    }

    // 3. The same Kotlin package.
    const inPackage = this.byPackage.get(file.packageName)?.get(simple);
    if (inPackage) return this.lookupFqcn(inPackage);

    // 4. A unique simple name across the repo.
    const candidates = this.bySimpleName.get(simple) ?? [];
    if (candidates.length === 1) return this.lookupFqcn(candidates[0]);

    return { status: 'external' };
  }

  private lookupFqcn(fqcn: string): KotlinResolution {
    if (this.duplicateFqcns.has(fqcn)) return { status: 'ambiguous', fqcn };
    const decl = this.byFqcn.get(fqcn);
    return decl ? { status: 'resolved', decl } : { status: 'external' };
  }

  /**
   * The declaration and its resolved supertypes, nearest first, bounded to
   * `MAX_SUPERTYPE_HOPS` and cycle-safe. An external or ambiguous supertype ends that branch:
   * it contributes no node, only its NAME, which `supertypeNames` returns.
   */
  supertypeChain(decl: KotlinTypeDecl): KotlinTypeDecl[] {
    // Keyed by file too: a duplicated FQCN has two declarations with two different chains.
    const cacheKey = `${decl.filePath}#${decl.fqcn}`;
    const cached = this.chainCache.get(cacheKey);
    if (cached) return cached;
    const out: KotlinTypeDecl[] = [decl];
    const seen = new Set<string>([decl.fqcn]);
    let frontier = [decl];
    for (let hop = 0; hop < MAX_SUPERTYPE_HOPS && frontier.length > 0; hop++) {
      const next: KotlinTypeDecl[] = [];
      for (const current of frontier) {
        const file = this.byFile.get(current.filePath);
        if (!file) continue;
        for (const spec of current.supertypes) {
          const hit = this.resolve(spec.name, file);
          if (hit.status !== 'resolved' || seen.has(hit.decl.fqcn)) continue;
          seen.add(hit.decl.fqcn);
          out.push(hit.decl);
          next.push(hit.decl);
        }
      }
      frontier = next;
    }
    this.chainCache.set(cacheKey, out);
    return out;
  }

  /**
   * Every supertype NAME reachable from `decl`, in-repo ones resolved and external ones kept
   * as written. This is what a framework base-class check matches on: `AppCompatActivity` is
   * never declared in the repository.
   */
  supertypeNames(decl: KotlinTypeDecl): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const node of this.supertypeChain(decl)) {
      for (const spec of node.supertypes) {
        if (seen.has(spec.name)) continue;
        seen.add(spec.name);
        out.push(spec.name);
      }
    }
    return out;
  }

  /**
   * The method id for `name` on `decl`, then on its resolved superclasses, then on its
   * companion — the `kt-member` lookup order. Undefined when nothing declares it.
   */
  findMethod(decl: KotlinTypeDecl, name: string): string | undefined {
    for (const node of this.supertypeChain(decl)) {
      const hit = node.methodsByName.get(name);
      if (hit) return hit;
    }
    for (const node of this.supertypeChain(decl)) {
      const hit = node.staticMethodsByName.get(name);
      if (hit) return hit;
    }
    return undefined;
  }

  /**
   * The single in-scope implementation of an interface, for the `iface-impl` tier. TWO OR MORE
   * implementations ABSTAIN (undefined): guessing one and calling it a call edge is the exact
   * failure this substrate is precision-first about.
   */
  soleImplementation(iface: KotlinTypeDecl): KotlinTypeDecl | undefined {
    if (iface.kind !== 'interface') return undefined;
    const impls = this.implementorsOf(iface.fqcn);
    return impls.length === 1 ? impls[0] : undefined;
  }

  /**
   * Every in-scope declaration whose supertype chain reaches `fqcn`. Built ONCE for the whole
   * index — the per-interface scan was the same repo-wide walk repeated per unresolved site.
   */
  private implementorsOf(fqcn: string): readonly KotlinTypeDecl[] {
    if (!this.implementors) {
      const index = new Map<string, KotlinTypeDecl[]>();
      for (const decl of this.byFqcn.values()) {
        if (this.duplicateFqcns.has(decl.fqcn)) continue;
        for (const ancestor of this.supertypeChain(decl)) {
          if (ancestor.fqcn === decl.fqcn) continue;
          const bucket = index.get(ancestor.fqcn);
          if (bucket) bucket.push(decl);
          else index.set(ancestor.fqcn, [decl]);
        }
      }
      this.implementors = index;
    }
    return this.implementors.get(fqcn) ?? [];
  }
}
