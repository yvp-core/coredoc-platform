/**
 * A0/A6 probe — measure the anonymous-callback recall delta of `resolveAnonCallbacks` on a real repo.
 *
 *   tsx scripts/probe-anon-recall.ts <repoName> <repoRoot>
 *
 * Runs the deterministic substrate (buildBaseline → discover → structural → SCIP) twice, with the
 * flag OFF then ON, and reports:
 *   - function-node and resolved-call-edge deltas (the recall win);
 *   - how many resolved call edges have a PROMOTED anon-callback as their caller (the new edges,
 *     keyed off the synthetic name `<callee>@<argIndex>#<startLine>`);
 *   - a 0-fabrication check: every such edge must resolve to a real in-repo function node;
 *   - an A0 signal: resolved BARE-callee edges with the flag OFF (function references SCIP already
 *     captures without any new capture pass — i.e. function-as-value registration is already covered).
 *
 * SCIP needs the target repo's node_modules present. Two full index passes → expect tens of seconds.
 */
import { buildBaseline } from '../src/facts/index.js';

/** Synthetic anon-callback function name: `<callee>@<argIndex>#<startLine>`. */
const SYNTH = /@\d+#\d+$/;

async function run(repoRoot: string, repoName: string, resolveAnonCallbacks: boolean) {
  const b = await buildBaseline({ repoRoot, repoName }, { runScip: true, resolveAnonCallbacks });
  const fns = [...b.graph.functions.values()];
  const calls = [...b.graph.calls.values()];
  return { fns, calls, resolved: calls.filter((c) => c.calleeId) };
}

async function main(): Promise<void> {
  const [repoName, repoRoot] = process.argv.slice(2);
  if (!repoName || !repoRoot) {
    console.error('usage: tsx scripts/probe-anon-recall.ts <repoName> <repoRoot>');
    process.exit(1);
  }

  console.error(`\n=== ${repoName}: resolveAnonCallbacks OFF vs ON ===`);
  const off = await run(repoRoot, repoName, false);
  const on = await run(repoRoot, repoName, true);

  const fmt = (s: typeof off) =>
    `functions=${s.fns.length} callsTotal=${s.calls.length} callsResolved=${s.resolved.length}`;
  console.error(`OFF: ${fmt(off)}`);
  console.error(`ON : ${fmt(on)}`);
  console.error(
    `Δ functions=+${on.fns.length - off.fns.length}  Δ callsResolved=+${on.resolved.length - off.resolved.length}`,
  );

  // The new recall: resolved edges whose CALLER is a promoted anonymous callback.
  const fnById = new Map(on.fns.map((f) => [f.id, f]));
  const fnIds = new Set(on.fns.map((f) => f.id));
  const synthFns = on.fns.filter((f) => SYNTH.test(f.name));
  const recallEdges = on.resolved.filter((c) => {
    const caller = fnById.get(c.callerId);
    return caller != null && SYNTH.test(caller.name);
  });
  // 0-fabrication: every recall edge must resolve to a real in-repo function node.
  const fabricated = recallEdges.filter((c) => c.calleeId != null && !fnIds.has(c.calleeId));

  console.error(`promoted anon-callback fn nodes: ${synthFns.length}`);
  console.error(`resolved edges whose caller IS a promoted anon-callback: ${recallEdges.length}`);
  console.error(`fabricated (callee not an in-repo node): ${fabricated.length}  ← must be 0`);

  // A0 signal: with the flag OFF, how many resolved edges already have a BARE (no-receiver) callee?
  // These are plain function calls + function-as-value references SCIP resolves without a new pass —
  // confirming function-as-value registration is already covered and A correctly scopes to inner-call
  // promotion only.
  const bareResolvedOff = off.resolved.filter((c) => !c.isMethodCall).length;
  console.error(`A0: resolved bare-callee edges with flag OFF (already SCIP-captured): ${bareResolvedOff}`);

  console.error('\n— sample recall edges (anon-callback caller → resolved in-repo callee) —');
  for (const c of recallEdges.slice(0, 12)) {
    const caller = fnById.get(c.callerId);
    const callee = c.calleeId != null ? fnById.get(c.calleeId) : undefined;
    console.error(
      `  ${caller?.name}  →  ${callee?.name ?? c.calleeExpression}   @ ${c.location.filePath}:${c.location.startLine}`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
