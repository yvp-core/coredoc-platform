/**
 * Topological Sort for Function Call Graph
 *
 * Sorts functions in leaf-first order (functions that don't call others come first).
 * This ensures callee summaries are available when processing callers.
 */

import { FunctionNode, CallEdge } from '@coredoc/core/types';

/**
 * A function with its call graph metadata
 */
export interface SortedFunction {
  /** The function node */
  function: FunctionNode;
  /** IDs of functions this one calls (direct callees) */
  calleeIds: string[];
  /**
   * Depth from leaf:
   * - 0 = leaf (no outgoing calls to other functions in this repo)
   * - higher = closer to entrypoint
   * - -1 = part of a cycle
   */
  depth: number;
}

/**
 * Result of topological sort
 */
export interface TopologicalSortResult {
  /** Functions sorted in processing order (leaves first) */
  sorted: SortedFunction[];
  /** Function IDs involved in cycles (still included in sorted, but marked) */
  cyclicFunctions: Set<string>;
}

/**
 * Performs a reverse topological sort on the function call graph.
 *
 * Uses Kahn's algorithm, but in reverse:
 * - Starts with leaf functions (no outgoing calls to resolved functions)
 * - Processes callers only after all their callees are processed
 *
 * @param functions - All functions in the repo (FunctionNode array)
 * @param calls - All call edges (CallEdge array)
 * @returns Sorted functions with metadata about their position in the call graph
 */
export function topologicalSort(functions: FunctionNode[], calls: CallEdge[]): TopologicalSortResult {
  // Build a map of function ID to function node for quick lookup
  const functionById = new Map<string, FunctionNode>();
  for (const fn of functions) {
    functionById.set(fn.id, fn);
  }

  // Build adjacency lists:
  // - outgoingEdges: callerId -> Set of calleeIds (functions this one calls)
  // - incomingEdges: calleeId -> Set of callerIds (functions that call this one)
  const outgoingEdges = new Map<string, Set<string>>();
  const incomingEdges = new Map<string, Set<string>>();

  // Initialize with empty sets for all functions
  for (const fn of functions) {
    outgoingEdges.set(fn.id, new Set());
    incomingEdges.set(fn.id, new Set());
  }

  // Populate edges from calls array
  // Only include edges where both caller and callee exist in our function set
  for (const call of calls) {
    const { callerId, calleeId } = call;

    // Skip if callee is unresolved or not in our function set
    if (!calleeId) continue;
    if (!functionById.has(callerId) || !functionById.has(calleeId)) continue;

    // Skip self-calls (direct recursion)
    if (callerId === calleeId) continue;

    outgoingEdges.get(callerId)?.add(calleeId);
    incomingEdges.get(calleeId)?.add(callerId);
  }

  // Kahn's algorithm in reverse - start with leaves (no outgoing edges)
  const result: SortedFunction[] = [];
  const depths = new Map<string, number>();
  const processed = new Set<string>();

  // Queue starts with leaf functions (functions that don't call any other function)
  const queue: string[] = [];
  for (const fn of functions) {
    const outgoing = outgoingEdges.get(fn.id);
    if (!outgoing || outgoing.size === 0) {
      queue.push(fn.id);
      depths.set(fn.id, 0);
    }
  }

  while (queue.length > 0) {
    const fnId = queue.shift()!;
    if (processed.has(fnId)) continue;
    processed.add(fnId);

    const fn = functionById.get(fnId)!;
    const calleeIds = Array.from(outgoingEdges.get(fnId) || []);

    result.push({
      function: fn,
      calleeIds,
      depth: depths.get(fnId) || 0,
    });

    // Process callers (functions that call this one)
    // A caller can be added to queue once ALL its callees are processed
    const callers = incomingEdges.get(fnId) || new Set();
    for (const callerId of callers) {
      if (processed.has(callerId)) continue;

      // Check if all callees of this caller are now processed
      const callerOutgoing = outgoingEdges.get(callerId) || new Set();
      const allCalleesProcessed = [...callerOutgoing].every((id) => processed.has(id));

      if (allCalleesProcessed) {
        // Calculate depth as max(callee depths) + 1
        const calleeDepths = [...callerOutgoing].map((id) => depths.get(id) || 0);
        const maxCalleeDepth = Math.max(0, ...calleeDepths);
        depths.set(callerId, maxCalleeDepth + 1);
        queue.push(callerId);
      }
    }
  }

  // Find functions involved in cycles (not yet processed)
  // These are functions that couldn't be added to the queue because
  // they're part of a cycle where no function has all callees processed
  const cyclicFunctions = new Set<string>();
  for (const fn of functions) {
    if (!processed.has(fn.id)) {
      cyclicFunctions.add(fn.id);
      // Still add them to result so they get summarized, but mark depth as -1
      result.push({
        function: fn,
        calleeIds: Array.from(outgoingEdges.get(fn.id) || []),
        depth: -1,
      });
    }
  }

  return { sorted: result, cyclicFunctions };
}
