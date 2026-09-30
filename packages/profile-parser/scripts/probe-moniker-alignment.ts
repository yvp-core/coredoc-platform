export function normalizeMonikerDescriptor(descriptor: string): string {
  // Caller has already split the SCIP symbol into (package, version, descriptor);
  // version is excluded here. Strip the file-namespace prefix and the arg suffix,
  // leaving the semantic suffix join key (e.g. `AuthSessions#createSession`).
  let d = descriptor.trim();
  d = d.replace(/\.$/, ''); // trailing term/member dot
  d = d.replace(/\(\)$/, ''); // trailing call parens
  // Drop everything up to and including the last backtick-quoted file token +
  // its closing `/ — i.e. the `src/.../`<file>.d.ts`/` file-namespace prefix.
  const fileNsEnd = d.lastIndexOf('`/');
  if (fileNsEnd !== -1) d = d.slice(fileNsEnd + 2);
  // Unwrap accessor sigils: AcmeApiClient#`<get>schedules` -> AcmeApiClient#schedules.
  d = d.replace(/`<get>([A-Za-z_$][\w$]*)`/g, '$1');
  d = d.replace(/`<set>([A-Za-z_$][\w$]*)`/g, '$1');
  return d;
}

import { buildBaseline } from '../src/facts/index.js';
import { isDefinition, loadScip, type LoadedScip, parseMoniker } from '../src/facts/scip/decode.js';

/** A normalized join entry on either side of the moniker hop. */
interface MonikerKey {
  packageName: string;
  normalizedDescriptor: string; // e.g. AuthSessions#createSession
  methodName: string; // e.g. createSession  (for the structural fallback)
  raw: string; // original descriptor (for diagnostics)
}

/** Last identifier of the normalized descriptor, sans Class# prefix and accessor sigils. */
function methodNameFromNormalized(normalized: string): string {
  const m = normalized.match(/([A-Za-z_$][\w$]*)$/);
  return m?.[1] ?? normalized;
}

/**
 * Build the SDK-source DEFINITION index for one target package: every method
 * definition occurrence in the SDK monorepo whose moniker package == targetPackage.
 * Keyed by `packageName + '::' + normalizedDescriptor` and (separately) by
 * `packageName + '::' + methodName` for the structural fallback floor.
 */
function buildSdkDefIndex(scip: LoadedScip, targetPackage: string) {
  const byDescriptor = new Map<string, MonikerKey>();
  const byMethod = new Map<string, MonikerKey>();
  let defs = 0;
  for (const doc of scip.documents) {
    for (const occ of doc.occurrences) {
      if (!isDefinition(occ.symbolRoles)) continue;
      const mon = parseMoniker(occ.symbol);
      if (!('descriptors' in mon)) continue;
      if (mon.packageName !== targetPackage) continue;
      if (!mon.descriptors.endsWith('().')) continue; // method definitions only
      const normalizedDescriptor = normalizeMonikerDescriptor(mon.descriptors);
      const methodName = methodNameFromNormalized(normalizedDescriptor);
      const entry: MonikerKey = {
        packageName: mon.packageName,
        normalizedDescriptor,
        methodName,
        raw: mon.descriptors,
      };
      byDescriptor.set(`${mon.packageName}::${normalizedDescriptor}`, entry);
      byMethod.set(`${mon.packageName}::${methodName}`, entry);
      defs++;
    }
  }
  return { byDescriptor, byMethod, defs };
}

/**
 * Collect the DISTINCT consumer-side method-call references to targetPackage from a
 * decoded SCIP index. Distinct because the join rate is a property of the descriptor
 * set, not the call-site count (one method called N times is one join key).
 */
function loadConsumerMonikers(scip: LoadedScip, targetPackage: string): MonikerKey[] {
  const seen = new Map<string, MonikerKey>();
  for (const doc of scip.documents) {
    for (const occ of doc.occurrences) {
      if (isDefinition(occ.symbolRoles)) continue; // references only
      const mon = parseMoniker(occ.symbol);
      if (!('descriptors' in mon)) continue;
      if (mon.packageName !== targetPackage) continue;
      if (!mon.descriptors.endsWith('().')) continue; // method-call refs only
      const normalizedDescriptor = normalizeMonikerDescriptor(mon.descriptors);
      const methodName = methodNameFromNormalized(normalizedDescriptor);
      const key = `${mon.packageName}::${normalizedDescriptor}`;
      if (!seen.has(key)) {
        seen.set(key, {
          packageName: mon.packageName,
          normalizedDescriptor,
          methodName,
          raw: mon.descriptors,
        });
      }
    }
  }
  return [...seen.values()];
}

function pct(n: number, d: number): string {
  return d === 0 ? 'n/a' : `${((n / d) * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  // Defaults match the planning measurements; overridable for other fleets.
  const args = process.argv.slice(2);
  const opt = (flag: string, dflt: string) => {
    const i = args.indexOf(flag);
    return i !== -1 && args[i + 1] ? args[i + 1] : dflt;
  };
  const sdkRepoRoot = opt('--sdk', '/path/to/workspace/shared-packages');
  const consumerScip = opt('--consumer-scip', '/path/to/workspace/api-server/index.scip');
  const targetPackage = opt('--package', '@acme/api-client');
  const threshold = Number(opt('--threshold', '0.75'));

  console.error(`[probe] target package: ${targetPackage}`);
  console.error(`[probe] consumer SCIP : ${consumerScip}`);
  console.error(`[probe] SDK source    : ${sdkRepoRoot}  (indexing from monorepo root — node_modules must be present)`);

  // SDK side: index the monorepo root so scip-typescript can resolve cross-package
  // monikers (a single package subdir has no node_modules → SCIP skips, scip=undefined).
  const t0 = Date.now();
  const sdk = await buildBaseline({ repoRoot: sdkRepoRoot, repoName: 'sdk-source' }, { runScip: true });
  console.error(
    `[probe] SDK baseline in ${((Date.now() - t0) / 1000).toFixed(1)}s (functions=${sdk.graph.functions.size}, errors=${sdk.errors.length})`,
  );
  if (!sdk.scip) {
    console.error('[probe] FATAL: SDK SCIP index missing (degraded). Reasons:');
    for (const e of sdk.errors) console.error(`  [${e.severity}] ${e.message}`);
    process.exit(2);
  }
  const sdkIndex = buildSdkDefIndex(sdk.scip, targetPackage);
  console.error(
    `[probe] SDK method definitions for ${targetPackage}: ${sdkIndex.defs} (distinct descriptor keys=${sdkIndex.byDescriptor.size}, method keys=${sdkIndex.byMethod.size})`,
  );

  // Consumer side: reuse the cached consumer index (no re-index).
  const consumer = loadConsumerMonikers(loadScip(consumerScip), targetPackage);
  console.error(`[probe] consumer distinct method-call descriptors for ${targetPackage}: ${consumer.length}`);

  // Join 1 — descriptor (the proposed primary key).
  let descMatched = 0;
  const descMisses: string[] = [];
  for (const c of consumer) {
    if (sdkIndex.byDescriptor.has(`${c.packageName}::${c.normalizedDescriptor}`)) descMatched++;
    else descMisses.push(c.raw);
  }
  // Join 2 — structural (packageName, methodName) FALLBACK floor.
  let methMatched = 0;
  for (const c of consumer) {
    if (sdkIndex.byMethod.has(`${c.packageName}::${c.methodName}`)) methMatched++;
  }

  const descRate = consumer.length ? descMatched / consumer.length : 0;
  const _methRate = consumer.length ? methMatched / consumer.length : 0;

  console.error('\n========== MONIKER-ALIGNMENT PROBE RESULT ==========');
  console.error(`descriptor-join     : ${descMatched}/${consumer.length}  (${pct(descMatched, consumer.length)})`);
  console.error(
    `structural-fallback : ${methMatched}/${consumer.length}  (${pct(methMatched, consumer.length)})  [floor]`,
  );
  console.error(`threshold           : ${(threshold * 100).toFixed(0)}%`);
  console.error('\nfirst 15 descriptor-join misses (should fall through to structural fallback):');
  for (const m of descMisses.slice(0, 15)) console.error(`  ${m}`);

  if (descRate < threshold) {
    console.error(
      `\n[probe] FAIL — descriptor-join ${pct(descMatched, consumer.length)} < threshold ${(threshold * 100).toFixed(0)}%. ` +
        `Per §9, fall back to the structural (packageName, methodName) join (measured ${pct(methMatched, consumer.length)}).`,
    );
    process.exit(1);
  }
  console.error(
    `\n[probe] PASS — descriptor-join ${pct(descMatched, consumer.length)} >= threshold. Symbol hop is GO.`,
  );
}

// Only run as CLI entry point, not when imported by vitest.
if (
  typeof process !== 'undefined' &&
  (process.argv[1]?.endsWith('probe-moniker-alignment.ts') || process.argv[1]?.endsWith('probe-moniker-alignment.js'))
) {
  main().catch((e) => {
    console.error('[probe] FAILED:', e);
    process.exit(1);
  });
}
