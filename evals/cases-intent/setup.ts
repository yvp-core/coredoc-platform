// evals/cases-intent/setup.ts
/**
 * Deterministic seeding for the intent gate corpus (issue 06, Acceptance 1).
 *
 * The harness never parses at run time, so the fixture graph is built here,
 * once, before any model call:
 *
 *   wipe → copy pristine fixture → git init + commit
 *        → drift edit + commit  (makes ONE anchor read `changed`)
 *        → parse + push          (graph snapshot == that commit)
 *        → one more commit       (makes the snapshot read `stale`)
 *        → assert the traps are observable via `coredoc intent status`
 *        → assert the overlay is canonical and valid
 *
 * The staged assertion is the point: a setup that quietly skipped freshness
 * staging leaves every anchor `matched` against a `current` snapshot, and every
 * AC-12 trap that depends on unverified code evidence becomes unfalsifiable.
 */

import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join, posix, relative, resolve, sep } from 'node:path';
import { readIntentFile, serializeIntentFile } from '@coredoc/core';
import { projectDbUrl } from '@coredoc/core/utils';
import {
  CASES_INTENT_DIR,
  CLI_ENTRY,
  FIXTURE_PROJECT_ID,
  FIXTURE_REPO_NAME,
  FIXTURE_SOURCE_DIR,
  INTENT_TEST_OWNERSHIP_CONTENT,
  INTENT_TEST_OWNERSHIP_MARKER,
  INTENT_TEST_TARGET_PREFIX,
  intentEvalTarget,
  type IntentEvalTarget,
} from './target.js';

/**
 * The one content edit that separates the captured anchor from the parsed
 * graph. It targets the body of `roundCurrency` (not the end of the file) so
 * the FUNCTION node's versioned id changes, which is what the anchor stores.
 */
export const DRIFT_EDIT = {
  file: join('src', 'formatting', 'money.ts'),
  anchor: '  const sign = amountCents < 0 ? -1 : 1;\n',
  insert: '  // TODO(WID-42): revisit the half-up boundary during the pricing rework.\n',
} as const;

/** Appended after the parse so HEAD moves past the graph's recorded commit. */
const POST_PARSE_NOTE = 'Fixture note: the graph snapshot is deliberately one commit behind.\n';

const GIT_IDENTITY = ['-c', 'user.email=eval@coredoc.local', '-c', 'user.name=coredoc-eval'];

export interface IntentStatusReport {
  overlayStatus: string;
  items: number;
  relations: number;
  codeAnchors: number;
  byAuthority: Record<string, number>;
  /** ANCHOR-level histogram only (never the item-level `unmapped` count). */
  anchorCounts: Record<string, number>;
  unanchoredItems: number;
  /** repo name → `current` | `stale` | `unknown`. */
  snapshotFreshness: Record<string, string>;
}

/**
 * Read `coredoc intent status` output.
 *
 * Fails closed: a report whose overlay line is missing is NOT parsed into an
 * empty histogram (which `assertStagedTraps` would then reject for the wrong
 * reason, or worse, an "everything staged" default would accept).
 */
export function parseIntentStatusReport(text: string): IntentStatusReport {
  const overlay = /^\s*Overlay:\s+(\S+)/m.exec(text);
  if (!overlay) {
    throw new Error(`\`coredoc intent status\` output could not be read — no overlay line found in:\n${text}`);
  }
  const number = (re: RegExp): number => {
    const m = re.exec(text);
    return m ? Number.parseInt(m[1]!, 10) : 0;
  };
  const section = (header: RegExp): Record<string, number> => {
    const start = header.exec(text);
    if (!start) return {};
    const rest = text.slice(start.index + start[0].length);
    const out: Record<string, number> = {};
    for (const line of rest.split('\n')) {
      const entry = /^\s{4}([a-z_]+):\s+(\d+)\s*$/.exec(line);
      if (!entry) break;
      out[entry[1]!] = Number.parseInt(entry[2]!, 10);
    }
    return out;
  };
  const snapshotFreshness: Record<string, string> = {};
  for (const m of text.matchAll(/^\s*Graph snapshot \(([^)]+)\):\s+(\S+)\s*$/gm)) {
    snapshotFreshness[m[1]!] = m[2]!;
  }
  return {
    overlayStatus: overlay[1]!,
    items: number(/^\s*Items:\s+(\d+)/m),
    relations: number(/^\s*Relations:\s+(\d+)/m),
    codeAnchors: number(/^\s*Code anchors:\s+(\d+)/m),
    byAuthority: section(/^\s*Items:\s+\d+\n/m),
    anchorCounts: section(/^\s*Anchor status:\s*\n/m),
    unanchoredItems: number(/^\s*Unanchored items:\s+(\d+)/m),
    snapshotFreshness,
  };
}

/** Every trap S1 promises, asserted against what the CLI actually reports. */
export function assertStagedTraps(report: IntentStatusReport): void {
  const problems: string[] = [];
  if (report.overlayStatus !== 'ready') problems.push(`overlay status is "${report.overlayStatus}", expected ready`);
  if ((report.anchorCounts.changed ?? 0) < 1) {
    problems.push('no anchor is in the `changed` state — the drift edit did not reach the graph');
  }
  if ((report.anchorCounts.matched ?? 0) < 1) {
    problems.push('no anchor is in the `matched` state — there is nothing for `changed` to contrast against');
  }
  const stale = Object.entries(report.snapshotFreshness).filter(([, value]) => value === 'stale');
  if (stale.length === 0) {
    problems.push(
      `no repo reports a \`stale\` graph snapshot (saw ${JSON.stringify(report.snapshotFreshness)}) — ` +
        'the post-parse commit did not land',
    );
  }
  const candidates = report.byAuthority.candidate ?? 0;
  if (candidates < 1) problems.push('the overlay carries no candidate item — the AC-12 candidate traps are hollow');
  if ((report.byAuthority.accepted ?? 0) < 1) problems.push('the overlay carries no accepted item');
  if (problems.length > 0) {
    throw new Error(`Intent eval traps are NOT staged:\n  - ${problems.join('\n  - ')}`);
  }
}

/**
 * The cheap precondition from pilot finding 9: an overlay that drifted from its
 * canonical serializer is served to agents as-is, so a run over it measures a
 * file no maintainer tool would ever produce.
 */
export function assertOverlayCanonical(intentPath: string, expectedProjectId: string): string {
  const raw = readFileSync(intentPath, 'utf8');
  const read = readIntentFile(intentPath, { expectedProjectId, containmentRoot: dirname(dirname(intentPath)) });
  if (read.status !== 'ready') {
    throw new Error(`Overlay at ${intentPath} is ${read.status}: ${JSON.stringify(read, null, 2)}`);
  }
  const canonical = serializeIntentFile(read.file);
  if (raw !== canonical) {
    throw new Error(
      `Overlay at ${intentPath} is not in canonical form (writeIntentFile output). ` +
        'Rewrite it through writeIntentFile before running the eval.',
    );
  }
  return sha256(raw);
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function git(repoRoot: string, args: string[]): string {
  return execFileSync('git', [...GIT_IDENTITY, ...args], { cwd: repoRoot, encoding: 'utf8' }).trim();
}

export interface StageWorkspaceResult {
  repoRoot: string;
  overlaySha256: string;
  baselineCommit: string;
  driftCommit: string;
}

/**
 * Recreate the working checkout from the pristine fixture and stage the drift
 * edit. Separate from parse/push so its determinism is testable without a
 * built CLI.
 */
export function stageWorkspace(
  target: IntentEvalTarget = intentEvalTarget,
  options: { skipCopy?: boolean } = {},
): StageWorkspaceResult {
  assertFixtureTarget(target, 'stageWorkspace');
  if (!options.skipCopy) {
    rmSync(target.workspaceRoot, { recursive: true, force: true });
    mkdirSync(target.workspaceRoot, { recursive: true });
    cpSync(FIXTURE_SOURCE_DIR, target.repoRoot, { recursive: true });
    // SCIP indexing refuses to run without the target repo's dependency root.
    // The fixture has no dependencies, so an empty directory is the honest
    // representation — it is created here rather than committed because an
    // empty directory cannot be tracked by git anyway.
    mkdirSync(join(target.repoRoot, 'node_modules'), { recursive: true });
    git(target.repoRoot, ['init', '-q']);
    git(target.repoRoot, ['add', '-A']);
    git(target.repoRoot, ['commit', '-qm', 'widget-ordering fixture baseline']);
  }
  const baselineCommit = git(target.repoRoot, ['rev-parse', 'HEAD']);

  const moneyPath = join(target.repoRoot, DRIFT_EDIT.file);
  const before = readFileSync(moneyPath, 'utf8');
  if (!before.includes(DRIFT_EDIT.anchor)) {
    throw new Error(
      `The drift edit cannot be applied: ${DRIFT_EDIT.file} no longer contains its anchor line. ` +
        'Update DRIFT_EDIT together with the fixture source, or the `changed` anchor trap silently disappears.',
    );
  }
  writeFileSync(moneyPath, before.replace(DRIFT_EDIT.anchor, DRIFT_EDIT.anchor + DRIFT_EDIT.insert));
  git(target.repoRoot, ['add', '-A']);
  git(target.repoRoot, ['commit', '-qm', 'note the pending half-up review in the money helper']);

  return {
    repoRoot: target.repoRoot,
    overlaySha256: sha256(readFileSync(target.intentPath, 'utf8')),
    baselineCommit,
    driftCommit: git(target.repoRoot, ['rev-parse', 'HEAD']),
  };
}

/**
 * Resolve the real path of `path`, or of its nearest existing ancestor when it
 * does not exist yet. A containment check that gave up on a missing directory
 * would be trivially bypassed by pointing at a path setup is about to create.
 */
function realPathOfNearestExisting(path: string): string {
  let current = resolve(path);
  const suffix: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return resolve(path);
    suffix.unshift(current.slice(parent.length + 1));
    current = parent;
  }
  return suffix.length > 0 ? join(realpathSync(current), ...suffix) : realpathSync(current);
}

/**
 * A destructive root must have one of the harness-owned shapes, not merely sit
 * somewhere below a broad shared directory. In particular, `/tmp` is shared by
 * every process on the host and containment there is not ownership.
 */
export function assertDestroyableRoot(candidate: string, operation: string): void {
  const real = realPathOfNearestExisting(candidate);
  const fixtureWorkspace = realPathOfNearestExisting(join(CASES_INTENT_DIR, 'workspace'));
  if (real === fixtureWorkspace) return;

  const temp = realpathSync(tmpdir());
  const relativeToTemp = relative(temp, real);
  const segments = relativeToTemp.split(sep);
  const ownedTestWorkspace =
    relativeToTemp !== '' &&
    !relativeToTemp.startsWith(`..${sep}`) &&
    segments.length === 2 &&
    segments[0]!.startsWith(INTENT_TEST_TARGET_PREFIX) &&
    segments[1] === 'workspace';
  if (ownedTestWorkspace) {
    const markerPath = join(dirname(real), INTENT_TEST_OWNERSHIP_MARKER);
    if (existsSync(markerPath) && readFileSync(markerPath, 'utf8') === INTENT_TEST_OWNERSHIP_CONTENT) return;
  }

  throw new Error(
    `${operation} refuses to touch ${candidate} (real path ${real}): it is not an exact harness-owned ` +
      'fixture or test workspace root under cases-intent or a reserved temp prefix.',
  );
}

/**
 * The fixture target is the only one this script may create or destroy state
 * for. Pointing setup at the D5 `cd` diagnostic target would wipe a real
 * project database and rewrite a real checkout — and so would keeping the
 * fixture PROJECT ID while overriding only one path, so no single field is
 * trusted on its own. Every path setup mutates must describe one coherent,
 * harness-owned layout after symlinks are resolved.
 */
export function assertFixtureTarget(target: IntentEvalTarget, operation: string): void {
  if (target.diagnostic || target.projectId !== FIXTURE_PROJECT_ID) {
    throw new Error(
      `${operation} refuses to run against the diagnostic target "${target.projectId}": ` +
        'setup creates and destroys state, and the diagnostic arm points at a real project.',
    );
  }
  if (target.repoName !== FIXTURE_REPO_NAME) {
    throw new Error(`${operation} refuses repo "${target.repoName}": setup only owns fixture repo "${FIXTURE_REPO_NAME}".`);
  }
  assertDestroyableRoot(target.workspaceRoot, operation);

  const workspaceRoot = realPathOfNearestExisting(target.workspaceRoot);
  const casesWorkspace = realPathOfNearestExisting(join(CASES_INTENT_DIR, 'workspace'));
  const targetRoot = workspaceRoot === casesWorkspace ? realpathSync(CASES_INTENT_DIR) : dirname(workspaceRoot);
  const expectedRepoRoot = join(workspaceRoot, target.repoName);
  const repoRoot = realPathOfNearestExisting(target.repoRoot);
  if (repoRoot !== expectedRepoRoot) {
    throw new Error(
      `${operation} refuses repo root ${target.repoRoot}: expected ${expectedRepoRoot} inside the owned workspace.`,
    );
  }

  const expectedIntentPath = join(repoRoot, '.coredoc', 'intent.json');
  if (realPathOfNearestExisting(target.intentPath) !== expectedIntentPath) {
    throw new Error(`${operation} refuses intent path ${target.intentPath}: expected ${expectedIntentPath}.`);
  }

  const configDir = realPathOfNearestExisting(dirname(resolve(target.configPath)));
  if (configDir !== targetRoot) {
    throw new Error(
      `${operation} refuses config ${target.configPath}: its directory is outside the owned target root ${targetRoot}.`,
    );
  }
  const expectedConfigPath = join(targetRoot, 'coredoc.config.json');
  if (realPathOfNearestExisting(target.configPath) !== realPathOfNearestExisting(expectedConfigPath)) {
    throw new Error(
      `${operation} refuses config ${target.configPath}: it is outside the owned target root ${targetRoot}.`,
    );
  }
  // Preserve the spelling used by resolveIntentEvalTarget (`/var` vs macOS's
  // real `/private/var` alias) while the config containment check above still
  // compares canonical paths.
  const expectedDbUrl = projectDbUrl(dirname(resolve(target.configPath)), target.projectId);
  if (target.dbUrl !== expectedDbUrl) {
    throw new Error(`${operation} refuses database ${target.dbUrl}: expected ${expectedDbUrl} for the owned config.`);
  }
}

/** The overlay directory the control copy must not contain. */
const OVERLAY_DIR = '.coredoc';

/** Directory whose contents are git's own bookkeeping, never repo content. */
const GIT_DIR = '.git';

/**
 * Every file under `root`, as `/`-separated paths relative to it, sorted.
 * Directories are not listed — an empty directory carries no content a reading
 * agent could see, and `node_modules/` is created empty by staging. `.git/` is
 * excluded: it is the VCS's own storage, not repo content, and the control
 * copy intentionally carries a different (overlay-free, single-commit) git
 * history than the treatment — comparing it here would make an intentional
 * difference look like a divergence bug.
 */
export function listRepoFilesRelative(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name === GIT_DIR) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(relative(root, full).split(sep).join(posix.sep));
    }
  };
  walk(root);
  return files.sort();
}

/**
 * The control-copy invariant: the two checkouts differ by the overlay and by
 * NOTHING else.
 *
 * A control that also lost a source file would make the baseline arm's
 * artifacts worse for a reason that has nothing to do with product intent —
 * exactly the difference the gate would then credit to the overlay.
 */
export function assertControlCopy(target: IntentEvalTarget, controlRepoRoot: string): string[] {
  if (existsSync(join(controlRepoRoot, OVERLAY_DIR))) {
    throw new Error(
      `The control checkout at ${controlRepoRoot} still carries ${OVERLAY_DIR}/ — ` +
        'the baseline arm would be able to read the overlay it is the control for.',
    );
  }
  const treatment = listRepoFilesRelative(target.repoRoot);
  const control = listRepoFilesRelative(controlRepoRoot);
  const controlSet = new Set(control);
  const treatmentSet = new Set(treatment);
  const missing = treatment.filter((file) => !controlSet.has(file));
  const extra = control.filter((file) => !treatmentSet.has(file));
  const unexpectedlyMissing = missing.filter((file) => !file.startsWith(`${OVERLAY_DIR}/`));
  if (unexpectedlyMissing.length > 0 || extra.length > 0) {
    throw new Error(
      `The control checkout differs from the treatment beyond ${OVERLAY_DIR}/:\n` +
        `  missing from control: ${unexpectedlyMissing.join(', ') || 'none'}\n` +
        `  present only in control: ${extra.join(', ') || 'none'}`,
    );
  }
  if (missing.length === 0) {
    throw new Error(
      `The treatment checkout at ${target.repoRoot} carries no ${OVERLAY_DIR}/ file — ` +
        'there is no overlay for the control to be missing, so the two arms are identical.',
    );
  }
  return missing;
}

export interface StageControlCopyResult {
  /** The temp directory holding the control checkout — outside the repository tree. */
  controlWorkspaceRoot: string;
  controlRepoRoot: string;
  /** The treatment files the control does not have — all of them under `.coredoc/`. */
  omittedFiles: string[];
}

/** Prefix of the control temp directories. Recorded per run; never glob-swept. */
const CONTROL_WORKSPACE_PREFIX = 'coredoc-intent-control-';
/** Marker proving a prefix-shaped temp directory was actually created by this harness. */
const CONTROL_OWNERSHIP_MARKER = '.coredoc-intent-eval-control-v1';
const CONTROL_OWNERSHIP_CONTENT = 'owned by coredoc intent eval control staging\n';

/**
 * Prove the recorded path is a control workspace THIS harness created, or throw.
 *
 * The refusal is not recoverable automatically and must not be: a prefix-shaped
 * temp directory without the marker is either someone else's state or a control
 * staged by pre-marker code, and neither is something to delete on a guess. The
 * message therefore has to carry the manual remedy, because the only way past
 * it is a human removing both halves of the stale record by hand.
 */
function assertOwnedControlWorkspace(candidate: string, operation: string, recordPath: string): string {
  const real = realPathOfNearestExisting(candidate);
  const temp = realpathSync(tmpdir());
  const remedy =
    `To recover, delete the setup record ${recordPath} and, if ${candidate} is an orphaned control ` +
    'checkout of yours, remove that directory by hand; then re-run setup.';
  if (dirname(real) !== temp || !basename(real).startsWith(CONTROL_WORKSPACE_PREFIX)) {
    throw new Error(
      `${operation} refuses ${candidate}: it is not a recorded coredoc intent control workspace under ${temp}. ${remedy}`,
    );
  }
  const markerPath = join(real, CONTROL_OWNERSHIP_MARKER);
  if (!existsSync(markerPath) || readFileSync(markerPath, 'utf8') !== CONTROL_OWNERSHIP_CONTENT) {
    throw new Error(
      `${operation} refuses ${candidate}: the harness ownership marker ${CONTROL_OWNERSHIP_MARKER} is missing or ` +
        `invalid, so this directory cannot be proven to belong to the eval harness. ${remedy}`,
    );
  }
  return real;
}

/**
 * Best-effort removal of the control workspace the PREVIOUS setup recorded.
 *
 * Every setup stages a fresh temp control, so the old one is garbage. It is
 * removed by the recorded path only: `os.tmpdir()` is a shared directory and
 * deleting everything in it that matches {@link CONTROL_WORKSPACE_PREFIX} would
 * make this harness a reaper of other processes' state.
 *
 * Two non-deletable cases are distinguished, because they need opposite
 * treatment:
 *
 * - The recorded path does NOT exist (the OS swept temp, or a previous run
 *   already removed it). There is nothing to delete and nothing at risk, so
 *   setup says so and continues; aborting would leave the corpus unstageable
 *   until a human deleted a record pointing at a directory that is already gone.
 * - The recorded path EXISTS but carries no valid ownership marker. It is
 *   refused, always: a directory this harness cannot prove it owns is never
 *   deleted. The error names the manual remedy (see
 *   {@link assertOwnedControlWorkspace}) instead of leaving setup wedged with
 *   no way forward.
 *
 * Called at the TOP of {@link runSetup}, because staging the treatment wipes
 * the workspace the record lives in.
 */
export function removeRecordedControlWorkspace(target: IntentEvalTarget = intentEvalTarget): string | null {
  const recordPath = setupResultPath(target);
  if (!existsSync(recordPath)) return null;
  let recorded: string | undefined;
  try {
    recorded = (JSON.parse(readFileSync(recordPath, 'utf8')) as Partial<SetupResult>).controlWorkspaceRoot;
  } catch {
    // An unreadable record is not a licence to guess which directory to delete.
    return null;
  }
  if (!recorded) return null;
  if (!existsSync(recorded)) {
    console.log(
      `Recorded control workspace ${recorded} no longer exists — treating it as already removed and continuing.`,
    );
    return null;
  }
  const real = assertOwnedControlWorkspace(recorded, 'removeRecordedControlWorkspace', recordPath);
  rmSync(real, { recursive: true, force: true });
  return recorded;
}

/**
 * Build the control checkout from the STAGED treatment (not from the pristine
 * fixture): copying the same tree is what keeps the code content, the drift
 * edit and the git history identical, so the only variable left between the
 * arms is the overlay.
 *
 * The copy is staged in a temp directory OUTSIDE this repository. A sibling
 * `workspace-control/` was not isolation: the codex baseline arms run under a
 * read-only sandbox that permits arbitrary reads, and 9 of 12 of them reached
 * the treatment overlay by walking `../../workspace/fixture-repo/.coredoc/` up
 * out of their cwd. There is no such sibling from a temp root.
 *
 * `cpSync` also copies the treatment's `.git/` directory, which still
 * remembers the overlay: the copy inherits every commit that ever touched
 * `.coredoc/`, so `git status` reports it as a pending deletion and
 * `git show HEAD:.coredoc/intent.json` resurrects its content straight out of
 * the object store. A codex shell in the control has git and does exactly
 * that (9 of 12 gate-run baseline sessions were flagged through it). Denying
 * the tool was therefore not enough here either: the control's `.git/` is
 * replaced with a FRESH single-commit history over the already-overlay-free
 * tree, so there is no commit, ref or loose object anywhere that ever saw
 * `.coredoc/`.
 */
export function stageControlCopy(target: IntentEvalTarget = intentEvalTarget): StageControlCopyResult {
  assertFixtureTarget(target, 'stageControlCopy');
  const controlWorkspaceRoot = mkdtempSync(join(tmpdir(), CONTROL_WORKSPACE_PREFIX));
  writeFileSync(join(controlWorkspaceRoot, CONTROL_OWNERSHIP_MARKER), CONTROL_OWNERSHIP_CONTENT, { flag: 'wx' });
  const controlRepoRoot = join(controlWorkspaceRoot, target.repoName);
  cpSync(target.repoRoot, controlRepoRoot, { recursive: true });
  rmSync(join(controlRepoRoot, OVERLAY_DIR), { recursive: true, force: true });
  // Replace the inherited history rather than trim it: the overlay lives in
  // past commits, not just the working tree, and there is no supported git
  // operation that forgets a path from history without rewriting it.
  rmSync(join(controlRepoRoot, '.git'), { recursive: true, force: true });
  git(controlRepoRoot, ['init', '-q']);
  git(controlRepoRoot, ['add', '-A']);
  git(controlRepoRoot, ['commit', '-qm', 'control fixture (overlay-less)']);
  return { controlWorkspaceRoot, controlRepoRoot, omittedFiles: assertControlCopy(target, controlRepoRoot) };
}

function cli(target: IntentEvalTarget, args: string[]): string {
  return execFileSync('node', [CLI_ENTRY, ...args, '-c', target.configPath], {
    cwd: dirname(target.configPath),
    encoding: 'utf8',
    env: { ...process.env, COREDOC_DB_BACKEND: 'sqlite' },
    maxBuffer: 32 * 1024 * 1024,
  });
}

/**
 * Graph-level determinism evidence (review P3-11): repeating the sha of a
 * COPIED overlay file proves only that `cp` is deterministic. These counts and
 * the symbol-content hash come out of the parse the setup just performed, so
 * comparing them across two setups actually exercises the pipeline.
 */
export interface GraphFingerprint {
  files: number;
  functions: number;
  classes: number;
  entities: number;
  calls: number;
  /** sha256 over the sorted versioned ids of every function/class node. */
  symbolsSha256: string;
}

export function readGraphFingerprint(target: IntentEvalTarget = intentEvalTarget): GraphFingerprint {
  const outputPath = join(
    dirname(target.configPath),
    'coredoc-output',
    target.projectId,
    `${target.repoName}.json`,
  );
  const parsed = JSON.parse(readFileSync(outputPath, 'utf8')) as {
    files?: unknown[];
    functions?: { versionedId?: string }[];
    classes?: { versionedId?: string }[];
    entities?: unknown[];
    calls?: unknown[];
  };
  const versionedIds = [...(parsed.functions ?? []), ...(parsed.classes ?? [])]
    .map((node) => node.versionedId ?? '')
    .sort();
  return {
    files: parsed.files?.length ?? 0,
    functions: parsed.functions?.length ?? 0,
    classes: parsed.classes?.length ?? 0,
    entities: parsed.entities?.length ?? 0,
    calls: parsed.calls?.length ?? 0,
    symbolsSha256: sha256(versionedIds.join('\n')),
  };
}

export interface SetupResult {
  projectId: string;
  repoRoot: string;
  /**
   * The temp directory holding the control checkout. Recorded so the next
   * setup can remove exactly this one, and so the runner can prove the control
   * the report describes still exists.
   */
  controlWorkspaceRoot: string;
  /** The overlay-free copy the baseline arm runs in — outside the repository tree. */
  controlRepoRoot: string;
  /** The files the control copy omits — the overlay, and only the overlay. */
  controlOmittedFiles: string[];
  overlaySha256: string;
  graphFingerprint: GraphFingerprint;
  /** Commit the pushed graph represents. */
  graphCommit: string;
  /** Commit the checkout is on when the agents run — deliberately ahead. */
  headCommit: string;
  report: IntentStatusReport;
  statusOutput: string;
}

/** Full seeding sequence. Idempotent: every run starts from a clean slate. */
export async function runSetup(target: IntentEvalTarget = intentEvalTarget): Promise<SetupResult> {
  assertFixtureTarget(target, 'runSetup');
  // Before anything is wiped: staging the treatment deletes the workspace the
  // previous setup's record (and with it the previous control path) lives in.
  removeRecordedControlWorkspace(target);
  if (!existsSync(CLI_ENTRY)) {
    throw new Error(`coredoc CLI not built at ${CLI_ENTRY} — run \`pnpm build\` first.`);
  }
  const configDir = dirname(target.configPath);
  rmSync(join(configDir, 'coredoc-output', target.projectId), { recursive: true, force: true });
  // Compiled-profile cache: a stale compile would silently parse the fixture
  // with a previous profile after the profile itself changed.
  rmSync(join(configDir, 'dist', 'coredoc-parsers', target.projectId), { recursive: true, force: true });
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(join(configDir, 'coredoc.db.d', `${target.projectId}.db${suffix}`), { recursive: true, force: true });
  }

  const staged = stageWorkspace(target);
  const graphCommit = staged.driftCommit;

  cli(target, ['parse', '-r', target.repoName, '-p', target.projectId]);
  cli(target, [
    'push',
    target.repoName,
    '-p',
    target.projectId,
    '-b',
    'sqlite',
    '--no-summaries',
    '--no-embeddings',
  ]);

  // Move HEAD past the parsed commit: this is what makes snapshotFreshness
  // `stale` instead of `current` — a dirty tree would only produce `unknown`.
  const readmePath = join(target.repoRoot, 'README.md');
  writeFileSync(readmePath, `${readFileSync(readmePath, 'utf8')}\n${POST_PARSE_NOTE}`);
  git(target.repoRoot, ['add', '-A']);
  git(target.repoRoot, ['commit', '-qm', 'record the fixture snapshot note']);
  const headCommit = git(target.repoRoot, ['rev-parse', 'HEAD']);

  // The control checkout is copied from the FINAL treatment state (post-parse
  // commit included), so the two arms see the same code and the same freshness.
  const control = stageControlCopy(target);

  cli(target, ['intent', 'validate', '-p', target.projectId]);
  const statusOutput = cli(target, ['intent', 'status', '-p', target.projectId]);
  const report = parseIntentStatusReport(statusOutput);
  assertStagedTraps(report);
  const overlaySha256 = assertOverlayCanonical(target.intentPath, target.projectId);
  if (overlaySha256 !== staged.overlaySha256) {
    throw new Error('The overlay changed during setup — parse, push or git staging touched .coredoc/intent.json.');
  }

  const result: SetupResult = {
    projectId: target.projectId,
    repoRoot: target.repoRoot,
    controlWorkspaceRoot: control.controlWorkspaceRoot,
    controlRepoRoot: control.controlRepoRoot,
    controlOmittedFiles: control.omittedFiles,
    overlaySha256,
    graphFingerprint: readGraphFingerprint(target),
    graphCommit,
    headCommit,
    report,
    statusOutput,
  };
  // The runner reads this instead of re-deriving fingerprints: the graph's
  // commit is only knowable at the moment of the parse, and the report has to
  // state which checkout the graph represents (Acceptance 5).
  writeFileSync(setupResultPath(target), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

/** Where {@link runSetup} records the fingerprints the runner reports. */
export function setupResultPath(target: IntentEvalTarget = intentEvalTarget): string {
  return join(target.workspaceRoot, 'setup-result.json');
}

/** Read the recorded setup, or explain that setup has not run for this target. */
export function readSetupResult(target: IntentEvalTarget = intentEvalTarget): SetupResult {
  const path = setupResultPath(target);
  if (!existsSync(path)) {
    throw new Error(
      `No setup record at ${path} — run \`pnpm --dir evals eval:intent:setup\` before the eval. ` +
        'The harness never parses at run time.',
    );
  }
  return JSON.parse(readFileSync(path, 'utf8')) as SetupResult;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runSetup()
    .then((result) => {
      console.log(result.statusOutput);
      console.log(`overlay sha256: ${result.overlaySha256}`);
      console.log(`graph:          ${JSON.stringify(result.graphFingerprint)}`);
      console.log(`graph commit:   ${result.graphCommit}`);
      console.log(`HEAD commit:    ${result.headCommit}`);
      console.log(
        `control repo:   ${result.controlRepoRoot} (omits ${result.controlOmittedFiles.join(', ')})`,
      );
      console.log('Intent eval corpus is staged.');
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
