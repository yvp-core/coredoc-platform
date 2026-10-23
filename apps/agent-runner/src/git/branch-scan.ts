import type { TurnAssignment } from '@coredoc/core/agent-runner';
import type { Git } from './git.js';

type BranchScan = NonNullable<TurnAssignment['branchScan']>;

const SCAN_CONCURRENCY = 8;
const SCAN_TIMEOUT_MS = 20_000;

export interface BaseCandidates {
  epicKey: string;
  /** Repositories with at least one branch containing the epic key. */
  listings: Array<{ key: string; defaultBranch: string | null; matching: string[] }>;
  unchecked: string[];
}

/** One `ls-remote` per repository gives its default branch and every head, whatever their number. */
export async function listBaseCandidates(git: Git, scan: BranchScan, cwd: string): Promise<BaseCandidates | null> {
  const { epicKey } = scan;
  if (!epicKey) return null;
  // PROJ-1 must not match PROJ-12: no digit may follow the key.
  const needle = new RegExp(`${epicKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![0-9])`, 'i');
  const result: BaseCandidates = { epicKey, listings: [], unchecked: [] };
  const queue = [...scan.repositories];
  const listed = new Map<string, { defaultBranch: string | null; matching: string[] } | null>();
  await Promise.all(
    Array.from({ length: Math.min(SCAN_CONCURRENCY, queue.length) }, async () => {
      for (let repository = queue.shift(); repository; repository = queue.shift()) {
        const answer = await git.run(['ls-remote', '--symref', '--', repository.cloneUrl, 'HEAD', 'refs/heads/*'], {
          cwd,
          authUrl: repository.cloneUrl,
          allowFailure: true,
          timeoutMs: SCAN_TIMEOUT_MS,
        });
        listed.set(repository.key, answer.code === 0 ? parseHeads(answer.stdout, needle) : null);
      }
    }),
  );
  for (const { key } of scan.repositories) {
    const listing = listed.get(key);
    if (!listing) result.unchecked.push(key);
    else if (listing.matching.length) result.listings.push({ key, ...listing });
  }
  return result;
}

function parseHeads(output: string, needle: RegExp): { defaultBranch: string | null; matching: string[] } {
  let defaultBranch: string | null = null;
  const matching: string[] = [];
  for (const line of output.split('\n')) {
    const symref = /^ref: refs\/heads\/(\S+)\tHEAD$/.exec(line);
    if (symref) defaultBranch = symref[1]!;
    const head = /^[0-9a-f]+\trefs\/heads\/(\S+)$/.exec(line);
    if (head && needle.test(head[1]!)) matching.push(head[1]!);
  }
  return { defaultBranch, matching: matching.sort() };
}
