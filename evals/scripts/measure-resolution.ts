/**
 * Re-measure gate for the cross-repo-linking redesign.
 *
 * Opens one project's live graph database, re-runs the distribution-by-protocol
 * resolution query (the spec §2 evidence query), and prints the resolvable rate
 * + events-resolved count. Run after a real demo re-parse + re-link to confirm
 * the spec §12 success criteria: rate rises toward the §2 ~96% projection and
 * events go from 0 to resolving.
 *
 * Usage:
 *   COREDOC_EVAL_PROJECT=<id> pnpm --filter @coredoc/evals measure:resolution
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';
import { projectDbUrl } from '@coredoc/core/utils';
import {
  BASELINE_RESOLVABLE_RATE,
  PROJECTED_RESOLVABLE_RATE,
  measureResolution,
  type ResolutionSnapshot,
} from './resolution-rate.js';

/** Repo root = two levels up from evals/scripts/. */
function repoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..');
}

/** Same project-owned DB-path convention as the eval harness. */
export function resolveDbUrl(env: NodeJS.ProcessEnv | Record<string, string | undefined>): string {
  const projectId = env.COREDOC_EVAL_PROJECT;
  if (!projectId) throw new Error('COREDOC_EVAL_PROJECT=<id> is required.');
  return projectDbUrl(repoRoot(), projectId);
}

/** Strip the libsql `file:` scheme to a filesystem path (for existence checks). */
export function dbFilePath(url: string): string {
  return url.startsWith('file:') ? url.slice('file:'.length) : url;
}

function pct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

export function formatSnapshot(snap: ResolutionSnapshot): string {
  const lines: string[] = [];
  lines.push('protocol            resolved  unresolved     total');
  for (const r of snap.byProtocol) {
    lines.push(
      `${r.protocol.padEnd(18)}${String(r.resolved).padStart(8)}${String(r.unresolved).padStart(12)}${String(r.total).padStart(10)}`,
    );
  }
  lines.push('');
  lines.push(`total external calls: ${snap.totalCalls}`);
  lines.push(`RESOLVES_TO edges: ${snap.resolvesToEdges}`);
  lines.push(`events resolved: ${snap.eventsResolved}`);
  lines.push(
    `resolvable: ${snap.resolvableResolved}/${snap.resolvableTotal} = ${pct(snap.resolvableRate)} ` +
      `(baseline ${pct(BASELINE_RESOLVABLE_RATE)} → projection ${pct(PROJECTED_RESOLVABLE_RATE)})`,
  );
  return lines.join('\n');
}

async function main(): Promise<void> {
  const url = resolveDbUrl(process.env);
  const client = createClient({ url });
  try {
    const snap = await measureResolution(client);
    console.log(`# Resolution re-measure — ${dbFilePath(url)}\n`);
    console.log(formatSnapshot(snap));
  } finally {
    client.close();
  }
}

// Run only when invoked directly (not when imported by the test).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
