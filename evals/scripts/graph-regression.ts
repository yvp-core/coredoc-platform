/**
 * Pre-deploy regression gate for a parser change: parse the same source with the old and the new
 * parser, then compare the two graphs. No model calls.
 *
 * Usage:
 *   pnpm --filter @coredoc/evals graph:regression <before.json> <after.json> [<before.json> <after.json> …]
 *     [--max-lost-edge-rate=0.005]
 *
 * Exits 1 when any pair fails (see graph-diff.ts for what must not change).
 */
import { readFileSync } from 'node:fs';
import type { ParsedRepo } from '@coredoc/core/types';
import { diffParsedRepos, formatGraphDiff } from './graph-diff.js';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined =>
  args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const files = args.filter((a) => !a.startsWith('--'));
if (files.length === 0 || files.length % 2 !== 0) {
  console.error('Usage: graph-regression <before.json> <after.json> [<before.json> <after.json> …]');
  process.exit(2);
}

const read = (path: string): ParsedRepo => JSON.parse(readFileSync(path, 'utf8')) as ParsedRepo;
const maxLostEdgeRate = flag('max-lost-edge-rate') ? Number(flag('max-lost-edge-rate')) : undefined;

let failed = false;
for (let i = 0; i < files.length; i += 2) {
  const diff = diffParsedRepos(read(files[i]), read(files[i + 1]), { maxLostEdgeRate });
  failed ||= diff.failures.length > 0;
  console.log(formatGraphDiff(diff));
}
process.exit(failed ? 1 : 0);
