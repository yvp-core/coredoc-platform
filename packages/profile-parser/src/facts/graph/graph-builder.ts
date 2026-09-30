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
  /** Index of UNRESOLVED structural call edges by call-site key, for in-place resolution. */
  private readonly unresolvedCallSites = new Map<string, string>(); // `${callerId}|${file}|${line}` -> edge id

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

  addCall(e: CallEdge): void {
    if (this.calls.has(e.id)) return;
    this.calls.set(e.id, e);
    if (!e.calleeId)
      this.unresolvedCallSites.set(this.siteKey(e.callerId, e.location.filePath, e.location.startLine), e.id);
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

  private siteKey(callerId: string, filePath: string, line: number): string {
    return `${callerId}|${filePath}|${line}`;
  }

  /**
   * Upgrade an existing unresolved structural call edge in place by setting calleeId — collapsing
   * the structural edge and the resolved edge into ONE. Returns true if a sibling existed; false if
   * none (caller may then add a fresh resolved edge). Keyed on (callerId, file, call-expression start
   * line). Known limitation: a multi-line member-call chain whose method token sits on a different
   * line than the call-expression start will not collapse (rare; appears as two edges — best-effort).
   */
  resolveInternalCall(callerId: string, filePath: string, line: number, calleeId: string): boolean {
    const key = this.siteKey(callerId, filePath, line);
    const edgeId = this.unresolvedCallSites.get(key);
    if (!edgeId) return false;
    const edge = this.calls.get(edgeId);
    if (!edge) return false;
    edge.calleeId = calleeId;
    this.unresolvedCallSites.delete(key);
    return true;
  }

  /** Remove the unresolved structural call edge at a site (it is being reclassified as an external call). */
  removeUnresolvedCallAt(callerId: string, filePath: string, line: number): void {
    const key = this.siteKey(callerId, filePath, line);
    const edgeId = this.unresolvedCallSites.get(key);
    if (edgeId) {
      this.calls.delete(edgeId);
      this.unresolvedCallSites.delete(key);
    }
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
