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
  private readonly unresolvedCallSites = new Map<string, string[]>(); // `${callerId}|${file}|${line}` -> edge ids
  /** Unresolved call edge id → 0-based column of its callee name token, when the structural pass knew it. */
  private readonly nameColumns = new Map<string, number>();

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

  /** `nameColumn`: 0-based column of the callee's name token, which SCIP matches by position. */
  addCall(e: CallEdge, nameColumn?: number): void {
    if (this.calls.has(e.id)) return;
    this.calls.set(e.id, e);
    if (e.calleeId) return;
    if (nameColumn !== undefined) this.nameColumns.set(e.id, nameColumn);
    const key = this.siteKey(e.callerId, e.location.filePath, e.location.startLine);
    const ids = this.unresolvedCallSites.get(key);
    if (ids) ids.push(e.id);
    else this.unresolvedCallSites.set(key, [e.id]);
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
   * Calls on one line (`this.publish(topicFor(X))`, `a.save(x); b.save(y)`) share the key, so a
   * named occurrence takes the sibling whose expression ends in that name AND whose name token
   * starts at `column` (the occurrence's start). Name alone decides only when exactly one sibling
   * has the name and a column is missing on either side. Without a match nothing is upgraded
   * (false), so the caller adds a fresh edge. Without `calleeName` the last-registered sibling is taken.
   */
  resolveInternalCall(
    callerId: string,
    filePath: string,
    line: number,
    calleeId: string,
    calleeName?: string,
    column?: number,
  ): boolean {
    const edgeId = this.takeUnresolvedCallAt(callerId, filePath, line, calleeName, column);
    const edge = edgeId ? this.calls.get(edgeId) : undefined;
    if (!edge) return false;
    edge.calleeId = calleeId;
    return true;
  }

  /** Remove the unresolved structural call edge at a site (it is being reclassified as an external call). */
  removeUnresolvedCallAt(callerId: string, filePath: string, line: number, calleeName?: string, column?: number): void {
    const edgeId = this.takeUnresolvedCallAt(callerId, filePath, line, calleeName, column);
    if (edgeId) this.calls.delete(edgeId);
  }

  private takeUnresolvedCallAt(
    callerId: string,
    filePath: string,
    line: number,
    calleeName?: string,
    column?: number,
  ): string | undefined {
    const key = this.siteKey(callerId, filePath, line);
    const ids = this.unresolvedCallSites.get(key);
    if (!ids) return undefined;
    const name = calleeName?.startsWith('#') ? calleeName.slice(1) : calleeName;
    let at = ids.length - 1;
    if (name) {
      // A callback reference (`xs.filter(isObj)`) or another call on the line must never claim
      // an unrelated sibling, and two same-named calls are told apart by position.
      const named = ids.flatMap((id, i) =>
        /([A-Za-z_$][\w$]*)\s*$/.exec(this.calls.get(id)?.calleeExpression ?? '')?.[1] === name ? [i] : [],
      );
      const atColumn = named.find((i) => column !== undefined && this.nameColumns.get(ids[i]) === column);
      const positionUnknown = column === undefined || !this.nameColumns.has(ids[named[0]]);
      at = atColumn ?? (named.length === 1 && positionUnknown ? named[0] : -1);
    }
    if (at < 0) return undefined;
    const [edgeId] = ids.splice(at, 1);
    if (ids.length === 0) this.unresolvedCallSites.delete(key);
    return edgeId;
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
