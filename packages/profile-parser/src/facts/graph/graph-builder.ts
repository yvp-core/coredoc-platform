import type {
  CallEdge,
  ClassNode,
  ClassReferenceEdge,
  DbOperation,
  EntityNode,
  EnumMemberReferenceEdge,
  EnumNode,
  Entrypoint,
  ExternalCallEdge,
  FileNode,
  FunctionNode,
  ImportEdge,
  InterfaceNode,
  Package,
  TypeAliasNode,
  VariableNode,
} from '@coredoc/core/types';

/**
 * In-memory graph every pipeline layer writes into. Nodes keyed by stable id;
 * edges keyed by edge id. Adding a node id twice merges (object spread, later wins);
 * adding an edge id twice is a no-op. The set of node ids is the canonical
 * referent set used by Layer 3 mapping and Layer 4 verification.
 */
export class CodeGraph {
  readonly packages = new Map<string, Package>();
  readonly files = new Map<string, FileNode>();
  readonly functions = new Map<string, FunctionNode>();
  readonly classes = new Map<string, ClassNode>();
  readonly interfaces = new Map<string, InterfaceNode>();
  readonly typeAliases = new Map<string, TypeAliasNode>();
  readonly enums = new Map<string, EnumNode>();
  readonly variables = new Map<string, VariableNode>();
  readonly entrypoints = new Map<string, Entrypoint>();
  readonly entities = new Map<string, EntityNode>();
  readonly dbOperations = new Map<string, DbOperation>();
  readonly calls = new Map<string, CallEdge>();
  readonly imports = new Map<string, ImportEdge>();
  readonly externalCalls = new Map<string, ExternalCallEdge>();
  /** Value-position enum-member references, keyed by edge id (source + enum + member). */
  readonly enumMemberRefs = new Map<string, EnumMemberReferenceEdge>();
  /** Construction/import references to classes, keyed by edge id (source + class + refKind + module). */
  readonly classRefs = new Map<string, ClassReferenceEdge>();

  private readonly nodeIds = new Set<string>();
  /**
   * UNRESOLVED structural call sites by `file|line`, for in-place resolution. A site added with its
   * callee name position is matched by that exact position, so several calls on one line resolve
   * independently; a site without one falls back to (caller, line).
   */
  private readonly unresolvedCallSites = new Map<string, UnresolvedCallSite[]>();

  addPackage(n: Package): void {
    this.packages.set(n.id, { ...this.packages.get(n.id), ...n });
    this.nodeIds.add(n.id);
  }
  addFile(n: FileNode): void {
    this.files.set(n.id, { ...this.files.get(n.id), ...n });
    this.nodeIds.add(n.id);
  }
  addFunction(n: FunctionNode): void {
    this.functions.set(n.id, { ...this.functions.get(n.id), ...n });
    this.nodeIds.add(n.id);
  }
  addClass(n: ClassNode): void {
    this.classes.set(n.id, { ...this.classes.get(n.id), ...n });
    this.nodeIds.add(n.id);
  }
  addInterface(n: InterfaceNode): void {
    this.interfaces.set(n.id, { ...this.interfaces.get(n.id), ...n });
    this.nodeIds.add(n.id);
  }
  addTypeAlias(n: TypeAliasNode): void {
    this.typeAliases.set(n.id, { ...this.typeAliases.get(n.id), ...n });
    this.nodeIds.add(n.id);
  }
  addEnum(n: EnumNode): void {
    this.enums.set(n.id, { ...this.enums.get(n.id), ...n });
    this.nodeIds.add(n.id);
  }
  addVariable(n: VariableNode): void {
    this.variables.set(n.id, { ...this.variables.get(n.id), ...n });
    this.nodeIds.add(n.id);
  }
  addEntrypoint(n: Entrypoint): void {
    this.entrypoints.set(n.id, n);
    this.nodeIds.add(n.id);
  }
  addEntity(n: EntityNode): void {
    this.entities.set(n.id, n);
    this.nodeIds.add(n.id);
  }
  addDbOperation(n: DbOperation): void {
    this.dbOperations.set(n.id, n);
    this.nodeIds.add(n.id);
  }

  /**
   * `site` is the callee name token (`foo` in `a.foo()`). Two identical calls on one line share an
   * edge id but are two sites, so a positioned site registers even when the edge already exists.
   */
  addCall(e: CallEdge, site?: CallSitePosition): void {
    const isNew = !this.calls.has(e.id);
    if (isNew) this.calls.set(e.id, e);
    if (e.calleeId || (!isNew && !site)) return;
    const key = this.lineKey(e.location.filePath, site?.line ?? e.location.startLine);
    const sites = this.unresolvedCallSites.get(key) ?? [];
    sites.push({ edgeId: e.id, callerId: e.callerId, column: site?.column, name: site?.name });
    this.unresolvedCallSites.set(key, sites);
  }
  addImport(e: ImportEdge): void {
    if (!this.imports.has(e.id)) this.imports.set(e.id, e);
  }
  addExternalCall(e: ExternalCallEdge): void {
    if (!this.externalCalls.has(e.id)) this.externalCalls.set(e.id, e);
  }
  /**
   * First site wins per (source, enum, member, module) — the tuple the edge id encodes. Repeated
   * comparisons against the same member collapse into one edge; the same member name read from two
   * different modules stays two edges (they are two different symbols).
   */
  addEnumMemberRef(e: EnumMemberReferenceEdge): void {
    if (!this.enumMemberRefs.has(e.id)) this.enumMemberRefs.set(e.id, e);
  }
  /**
   * First site wins per (source, class, refKind, module) — the tuple the edge id encodes. Repeated
   * `new X()` calls inside one function collapse into one edge; the same class name constructed from
   * two different modules stays two edges (they are two different symbols).
   */
  addClassRef(e: ClassReferenceEdge): void {
    if (!this.classRefs.has(e.id)) this.classRefs.set(e.id, e);
  }

  private lineKey(filePath: string, line: number): string {
    return `${filePath}|${line}`;
  }

  /**
   * The unresolved site a reference at (file, 1-based line, column) points at: the call whose name
   * token starts at that column (tree-sitter and scip-typescript both count UTF-16 units), else, for
   * a site recorded without a position, the caller's site on the line. A reference matching neither
   * is not a call (`xs.map(fn)`), so it never claims a call site.
   */
  private findSite(callerId: string, filePath: string, line: number, column?: number): UnresolvedCallSite | undefined {
    const sites = this.unresolvedCallSites.get(this.lineKey(filePath, line)) ?? [];
    return (
      (column === undefined ? undefined : sites.find((s) => s.column === column)) ??
      sites.find((s) => s.column === undefined && s.callerId === callerId)
    );
  }

  private dropSites(filePath: string, line: number, drop: (s: UnresolvedCallSite) => boolean): void {
    const key = this.lineKey(filePath, line);
    const rest = (this.unresolvedCallSites.get(key) ?? []).filter((s) => !drop(s));
    if (rest.length) this.unresolvedCallSites.set(key, rest);
    else this.unresolvedCallSites.delete(key);
  }

  /** The name recorded for the unresolved call whose callee name token sits exactly at (file, line, column). */
  unresolvedCallNameAt(filePath: string, line: number, column: number): string | undefined {
    return this.unresolvedCallSites.get(this.lineKey(filePath, line))?.find((s) => s.column === column)?.name;
  }

  /**
   * Upgrade an existing unresolved structural call edge in place by setting calleeId — collapsing
   * the structural edge and the resolved edge into ONE. Returns true if a sibling existed; false if
   * none (caller may then add a fresh resolved edge). `column` is the reference's column (see
   * `findSite`); without it, the site is keyed on (callerId, file, line) only.
   */
  resolveInternalCall(callerId: string, filePath: string, line: number, calleeId: string, column?: number): boolean {
    const site = this.findSite(callerId, filePath, line, column);
    if (!site) return false;
    this.dropSites(filePath, line, (s) => s === site);
    const edge = this.calls.get(site.edgeId);
    if (!edge) return false;
    // A second identical call on the line shares the edge: it is already this edge, not a new one.
    edge.calleeId ??= calleeId;
    return true;
  }

  /** Remove the unresolved structural call edge at a site (it is being reclassified as an external call). */
  removeUnresolvedCallAt(callerId: string, filePath: string, line: number, column?: number): void {
    const site = this.findSite(callerId, filePath, line, column);
    if (!site) return;
    this.dropSites(filePath, line, (s) => s.edgeId === site.edgeId);
    if (!this.calls.get(site.edgeId)?.calleeId) this.calls.delete(site.edgeId);
  }

  /** True if id was registered as a node (used to verify edge endpoints). */
  hasNode(id: string): boolean {
    return this.nodeIds.has(id);
  }

  /**
   * Fully remove a node id: from the canonical id registry (`nodeIds`) AND every node map. Use when a
   * verification pass drops a node, so later `hasNode()` checks in the SAME pass stay honest (e.g. a
   * hollow entity dropped first must not still read as present when a db-op's entityId is checked).
   * Edges (calls / imports / externalCalls) are not nodes — delete those from their maps directly.
   */
  removeNode(id: string): void {
    this.nodeIds.delete(id);
    this.packages.delete(id);
    this.files.delete(id);
    this.functions.delete(id);
    this.classes.delete(id);
    this.interfaces.delete(id);
    this.typeAliases.delete(id);
    this.enums.delete(id);
    this.variables.delete(id);
    this.entrypoints.delete(id);
    this.entities.delete(id);
    this.dbOperations.delete(id);
  }
}

/** Position of a call's callee name token: 1-based line, 0-based column, and the name itself. */
export interface CallSitePosition {
  line: number;
  column: number;
  name?: string;
}

interface UnresolvedCallSite {
  edgeId: string;
  callerId: string;
  column?: number;
  name?: string;
}
