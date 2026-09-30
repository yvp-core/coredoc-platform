import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DRIFT_EDIT,
  assertControlCopy,
  assertDestroyableRoot,
  assertFixtureTarget,
  assertOverlayCanonical,
  assertStagedTraps,
  parseIntentStatusReport,
  removeRecordedControlWorkspace,
  runSetup,
  sha256,
  listRepoFilesRelative,
  setupResultPath,
  stageControlCopy,
  stageWorkspace,
} from './setup.js';
import { createTempIntentTarget, type TempIntentTarget } from './test-target.js';
import {
  CASES_INTENT_DIR,
  CLI_ENTRY,
  COREDOC_REPO_ROOT,
  FIXTURE_SOURCE_DIR,
  INTENT_TEST_TARGET_PREFIX,
  resolveIntentEvalTarget,
} from './target.js';

/**
 * Temp roots created by a test, torn down after it. The suite never stages
 * anything into the shared corpus (see the `shared corpus` describe below).
 */
const disposables: (() => void)[] = [];
const disposable = (cleanup: () => void): void => {
  disposables.push(cleanup);
};
const tempTarget = (): TempIntentTarget => {
  const created = createTempIntentTarget();
  disposable(created.cleanup);
  return created;
};
/** A directory that is in NEITHER destroyable zone — inside the coredoc checkout. */
const OUTSIDE_BOTH_ZONES = join(COREDOC_REPO_ROOT, 'packages', 'cli');

afterEach(() => {
  while (disposables.length > 0) {
    try {
      disposables.pop()?.();
    } catch {
      // Cleanup failures must not turn into test failures for the next test.
    }
  }
});

const STATUS_WITH_TRAPS = `  Project:  intent-eval
  Repo:     fixture-repo
  Overlay:  ready (/tmp/fixture-repo/.coredoc/intent.json)
  Items:        10
    accepted: 7
    candidate: 2
    rejected: 1
  Relations:    8
  Code anchors: 4
  Anchor status:
    matched: 3
    changed: 1
  Unanchored items: 6
  Graph snapshot (fixture-repo): stale
  Note: Code anchors are implementation touchpoints, not conformance proof.
`;

const STATUS_ALL_MATCHED_AND_CURRENT = STATUS_WITH_TRAPS.replace('    matched: 3\n    changed: 1\n', '    matched: 4\n')
  .replace('Graph snapshot (fixture-repo): stale', 'Graph snapshot (fixture-repo): current');

describe('parseIntentStatusReport', () => {
  it('reads the anchor histogram and the snapshot freshness out of the CLI report', () => {
    const report = parseIntentStatusReport(STATUS_WITH_TRAPS);
    expect(report.overlayStatus).toBe('ready');
    expect(report.anchorCounts).toEqual({ matched: 3, changed: 1 });
    expect(report.snapshotFreshness).toEqual({ 'fixture-repo': 'stale' });
    expect(report.items).toBe(10);
    expect(report.byAuthority).toEqual({ accepted: 7, candidate: 2, rejected: 1 });
  });

  it('refuses a report it cannot read rather than reporting empty traps', () => {
    expect(() => parseIntentStatusReport('Error: project not found')).toThrow(/could not be read/i);
  });
});

describe('assertStagedTraps', () => {
  it('accepts a report carrying a changed anchor, a matched anchor and a stale snapshot', () => {
    expect(() => assertStagedTraps(parseIntentStatusReport(STATUS_WITH_TRAPS))).not.toThrow();
  });

  // Acceptance 1's passes-while-broken: setup that skipped freshness staging
  // leaves every anchor matched+current, and every AC-12 trap is hollow.
  it('rejects a report where the freshness traps were never staged', () => {
    expect(() => assertStagedTraps(parseIntentStatusReport(STATUS_ALL_MATCHED_AND_CURRENT))).toThrow(
      /changed.*anchor|stale/i,
    );
  });

  it('rejects a report with no matched anchor left to contrast against', () => {
    const noMatched = STATUS_WITH_TRAPS.replace('    matched: 3\n', '');
    expect(() => assertStagedTraps(parseIntentStatusReport(noMatched))).toThrow(/matched/i);
  });
});

describe('assertOverlayCanonical', () => {
  it('accepts the checked-in fixture overlay and returns its sha256', () => {
    const sha = assertOverlayCanonical(join(FIXTURE_SOURCE_DIR, '.coredoc', 'intent.json'), 'intent-eval');
    expect(sha).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects an overlay that drifted from the canonical serializer', () => {
    const dir = mkdtempSync(join(tmpdir(), 'intent-eval-canon-'));
    const path = join(dir, 'intent.json');
    const canonical = readFileSync(join(FIXTURE_SOURCE_DIR, '.coredoc', 'intent.json'), 'utf8');
    // Same semantic content, non-canonical formatting — exactly the drift the
    // pilot hit when maintainer edits bypassed writeIntentFile.
    writeFileSync(path, JSON.stringify(JSON.parse(canonical)));
    expect(() => assertOverlayCanonical(path, 'intent-eval')).toThrow(/canonical/i);
  });
});

describe('stageWorkspace', () => {
  it('produces a byte-identical overlay on repeated staging', () => {
    const { target } = tempTarget();
    const first = stageWorkspace(target);
    const second = stageWorkspace(target);
    expect(second.overlaySha256).toBe(first.overlaySha256);
    expect(existsSync(join(target.repoRoot, '.coredoc', 'intent.json'))).toBe(true);
  });

  it('applies the drift edit exactly once and fails loudly when its anchor text is gone', () => {
    const { target } = tempTarget();
    stageWorkspace(target);
    const money = join(target.repoRoot, DRIFT_EDIT.file);
    expect(readFileSync(money, 'utf8')).toContain(DRIFT_EDIT.insert);
    writeFileSync(money, readFileSync(money, 'utf8').replace(DRIFT_EDIT.anchor, ''));
    expect(() => stageWorkspace(target, { skipCopy: true })).toThrow(/drift edit/i);
  });
});

// Review P3-12: the only thing standing between `runSetup` and an `rmSync` of a
// real workspace is this guard, and the project id alone is a weak key. Two
// layouts are destroyable and no others: the exact checked-in fixture workspace
// and temp test targets carrying the helper's ownership marker.
describe('assertFixtureTarget / assertDestroyableRoot', () => {
  const fixtureTarget = resolveIntentEvalTarget({ ...process.env, COREDOC_INTENT_EVAL_PROJECT: 'intent-eval' });

  it('accepts the checked-in fixture target', () => {
    expect(() => assertFixtureTarget(fixtureTarget, 'test')).not.toThrow();
  });

  it('accepts a target staged under the system temp dir', () => {
    const { target } = tempTarget();
    expect(() => assertFixtureTarget(target, 'test')).not.toThrow();
  });

  it('refuses an arbitrary directory under the shared system temp root', () => {
    const root = mkdtempSync(join(tmpdir(), 'not-owned-by-intent-eval-'));
    disposable(() => rmSync(root, { recursive: true, force: true }));
    const target = resolveIntentEvalTarget({
      ...process.env,
      COREDOC_INTENT_EVAL_PROJECT: 'intent-eval',
      COREDOC_INTENT_EVAL_CONFIG: join(root, 'coredoc.config.json'),
      COREDOC_INTENT_EVAL_WORKSPACE_ROOT: join(root, 'workspace'),
    });

    expect(() => assertFixtureTarget(target, 'runSetup')).toThrow(/owned|target/i);
  });

  it('refuses a prefix-shaped temp target without the test-helper ownership marker', () => {
    const root = mkdtempSync(join(tmpdir(), INTENT_TEST_TARGET_PREFIX));
    disposable(() => rmSync(root, { recursive: true, force: true }));
    const target = resolveIntentEvalTarget({
      ...process.env,
      COREDOC_INTENT_EVAL_PROJECT: 'intent-eval',
      COREDOC_INTENT_EVAL_CONFIG: join(root, 'coredoc.config.json'),
      COREDOC_INTENT_EVAL_WORKSPACE_ROOT: join(root, 'workspace'),
    });

    expect(() => assertFixtureTarget(target, 'runSetup')).toThrow(/owned|target/i);
  });

  it('refuses a repo root outside the owned workspace', () => {
    const { root, target } = tempTarget();
    const repoRoot = join(root, 'sibling-repo');
    expect(() =>
      assertFixtureTarget(
        { ...target, repoRoot, intentPath: join(repoRoot, '.coredoc', 'intent.json') },
        'stageWorkspace',
      ),
    ).toThrow(/repo root|workspace/i);
  });

  it('refuses config and database paths outside the owned target root', () => {
    const { target } = tempTarget();
    const other = mkdtempSync(join(tmpdir(), 'not-owned-intent-config-'));
    disposable(() => rmSync(other, { recursive: true, force: true }));
    expect(() =>
      assertFixtureTarget(
        { ...target, configPath: join(other, 'coredoc.config.json'), dbUrl: `file:${join(other, 'db.sqlite')}` },
        'runSetup',
      ),
    ).toThrow(/config|target/i);
    expect(() =>
      assertFixtureTarget({ ...target, dbUrl: `file:${join(other, 'db.sqlite')}` }, 'runSetup'),
    ).toThrow(/database/i);
  });

  it('refuses the diagnostic target', () => {
    const diagnostic = resolveIntentEvalTarget({ ...process.env, COREDOC_INTENT_EVAL_PROJECT: 'cd' });
    expect(() => assertFixtureTarget(diagnostic, 'test')).toThrow(/diagnostic/i);
  });

  it('refuses a path in neither zone, and leaves it alone', () => {
    expect(() => assertDestroyableRoot(OUTSIDE_BOTH_ZONES, 'runSetup')).toThrow(/cases-intent/);
    expect(existsSync(OUTSIDE_BOTH_ZONES)).toBe(true);
  });

  it('refuses the zone roots THEMSELVES — a zone is a container, not a target', () => {
    expect(() => assertDestroyableRoot(tmpdir(), 'runSetup')).toThrow(/cases-intent/);
    expect(() => assertDestroyableRoot(CASES_INTENT_DIR, 'runSetup')).toThrow(/cases-intent/);
  });

  it('refuses a workspace outside both zones even under the fixture project id', () => {
    const target = resolveIntentEvalTarget({
      ...process.env,
      COREDOC_INTENT_EVAL_PROJECT: 'intent-eval',
      COREDOC_INTENT_EVAL_WORKSPACE_ROOT: OUTSIDE_BOTH_ZONES,
    });
    expect(() => assertFixtureTarget(target, 'runSetup')).toThrow(/cases-intent/);
    expect(existsSync(OUTSIDE_BOTH_ZONES)).toBe(true);
  });

  it('refuses a not-yet-created workspace path outside both zones', () => {
    const outside = join(OUTSIDE_BOTH_ZONES, 'nested', 'workspace');
    const target = resolveIntentEvalTarget({
      ...process.env,
      COREDOC_INTENT_EVAL_PROJECT: 'intent-eval',
      COREDOC_INTENT_EVAL_WORKSPACE_ROOT: outside,
    });
    expect(() => assertFixtureTarget(target, 'runSetup')).toThrow(/cases-intent/);
  });

  it('refuses a symlink that escapes both zones', () => {
    const link = join(dirname(fixtureTarget.workspaceRoot), 'workspace-escape-link');
    rmSync(link, { recursive: true, force: true });
    symlinkSync(OUTSIDE_BOTH_ZONES, link, 'dir');
    disposable(() => rmSync(link, { recursive: true, force: true }));
    const target = resolveIntentEvalTarget({
      ...process.env,
      COREDOC_INTENT_EVAL_PROJECT: 'intent-eval',
      COREDOC_INTENT_EVAL_WORKSPACE_ROOT: link,
    });
    expect(() => assertFixtureTarget(target, 'runSetup')).toThrow(/cases-intent/);
  });
});

/**
 * The control arm must not merely be forbidden the overlay — it must not be
 * able to reach it. Denying the tool was not enough (9 of 12 baseline sessions
 * in the 2026-08-26 claude run read `.coredoc/intent.json` out of the shared
 * cwd), and a sibling `workspace-control/` was not enough either: the codex
 * baselines run under a read-only sandbox that permits arbitrary reads, and 9
 * of 12 of them walked `../../workspace/fixture-repo/.coredoc/intent.json`.
 * The control copy therefore lives OUTSIDE the repository tree entirely.
 */
describe('stageControlCopy', () => {
  const staged = (): { target: TempIntentTarget['target']; control: ReturnType<typeof stageControlCopy> } => {
    const { target } = tempTarget();
    stageWorkspace(target);
    const control = stageControlCopy(target);
    disposable(() => rmSync(control.controlWorkspaceRoot, { recursive: true, force: true }));
    return { target, control };
  };

  it('stages the control copy under the system temp dir, outside the repository tree', () => {
    const { control } = staged();
    const real = realpathSync(control.controlWorkspaceRoot);
    expect(real.startsWith(realpathSync(tmpdir()) + sep)).toBe(true);
    expect(real.startsWith(realpathSync(COREDOC_REPO_ROOT) + sep)).toBe(false);
    expect(control.controlRepoRoot.startsWith(control.controlWorkspaceRoot + sep)).toBe(true);
  });

  it('copies the staged checkout without .coredoc and asserts that is the ONLY difference', () => {
    const { target, control } = staged();

    expect(existsSync(join(target.repoRoot, '.coredoc', 'intent.json'))).toBe(true);
    expect(existsSync(join(control.controlRepoRoot, '.coredoc'))).toBe(false);

    const treatment = listRepoFilesRelative(target.repoRoot);
    const controlFiles = listRepoFilesRelative(control.controlRepoRoot);
    const missing = treatment.filter((file) => !controlFiles.includes(file));
    const extra = controlFiles.filter((file) => !treatment.includes(file));
    expect(extra).toEqual([]);
    expect(missing.length).toBeGreaterThan(0);
    expect(missing.every((file) => file.startsWith('.coredoc/'))).toBe(true);
    expect(control.omittedFiles).toEqual(missing);
    // Same code state: the drift edit that makes the `changed` anchor trap is
    // part of the control too, so the arms read the same source.
    expect(readFileSync(join(control.controlRepoRoot, DRIFT_EDIT.file), 'utf8')).toContain(DRIFT_EDIT.insert);
  });

  it('refuses a control copy that diverges from the treatment beyond the overlay', () => {
    const { target, control } = staged();
    rmSync(join(control.controlRepoRoot, DRIFT_EDIT.file));
    expect(() => assertControlCopy(target, control.controlRepoRoot)).toThrow(/differ|missing/i);
  });

  it('refuses a control copy that still carries the overlay', () => {
    const { target, control } = staged();
    mkdirSync(join(control.controlRepoRoot, '.coredoc'), { recursive: true });
    writeFileSync(join(control.controlRepoRoot, '.coredoc', 'intent.json'), '{}');
    expect(() => assertControlCopy(target, control.controlRepoRoot)).toThrow(/overlay/i);
  });

  it('replaces the inherited git history so the overlay leaves no trace in it', () => {
    const { control } = staged();
    const runGit = (args: string[]): string =>
      execFileSync('git', args, { cwd: control.controlRepoRoot, encoding: 'utf8' }).trim();

    // Exactly one fresh commit — not the treatment's multi-commit history.
    const log = runGit(['log', '--oneline', '--all']);
    expect(log.split('\n').filter((line) => line.length > 0)).toHaveLength(1);

    // A clean tree: no " D .coredoc/intent.json" (or anything else) pending.
    expect(runGit(['status', '--porcelain'])).toBe('');

    // No object anywhere (any ref, any commit) ever saw the overlay path.
    const tracked = runGit(['ls-tree', '-r', '--name-only', 'HEAD']);
    expect(tracked.split('\n').some((path) => path.startsWith('.coredoc'))).toBe(false);

    // Belt and suspenders: grepping the whole rewritten history, not just HEAD.
    expect(() => runGit(['log', '--all', '--source', '--', '.coredoc'])).not.toThrow();
    expect(runGit(['log', '--all', '--pretty=format:', '--name-only', '--', '.coredoc'])).toBe('');
  });

  it('refuses to stage a control copy for a treatment workspace in neither zone', () => {
    const escaped = resolveIntentEvalTarget({
      ...process.env,
      COREDOC_INTENT_EVAL_PROJECT: 'intent-eval',
      COREDOC_INTENT_EVAL_WORKSPACE_ROOT: OUTSIDE_BOTH_ZONES,
    });
    expect(() => stageControlCopy(escaped)).toThrow(/cases-intent/);
  });
});

/**
 * The temp control workspace is recreated by every setup, so the previous one
 * has to go. It is removed by the PATH THE PREVIOUS SETUP RECORDED — never by
 * matching a name pattern against os.tmpdir(), which is a shared directory
 * this harness has no licence to sweep.
 */
describe('removeRecordedControlWorkspace', () => {
  const recordControl = (target: TempIntentTarget['target'], controlWorkspaceRoot: string): void => {
    mkdirSync(target.workspaceRoot, { recursive: true });
    writeFileSync(setupResultPath(target), JSON.stringify({ controlWorkspaceRoot }, null, 2));
  };

  it('removes the temp control workspace the previous setup recorded', () => {
    const { target } = tempTarget();
    stageWorkspace(target);
    const previous = stageControlCopy(target).controlWorkspaceRoot;
    disposable(() => rmSync(previous, { recursive: true, force: true }));
    recordControl(target, previous);

    expect(removeRecordedControlWorkspace(target)).toBe(previous);
    expect(existsSync(previous)).toBe(false);
  });

  it('refuses a recorded temp directory that lacks the harness ownership marker, naming the remedy', () => {
    const { target } = tempTarget();
    const unowned = mkdtempSync(join(tmpdir(), 'coredoc-intent-control-unowned-'));
    disposable(() => rmSync(unowned, { recursive: true, force: true }));
    recordControl(target, unowned);

    // A pre-marker or foreign directory is never deleted, but the operator is
    // told how to clear the record by hand instead of being wedged.
    expect(() => removeRecordedControlWorkspace(target)).toThrow(/owned|marker/i);
    expect(() => removeRecordedControlWorkspace(target)).toThrow(setupResultPath(target));
    expect(() => removeRecordedControlWorkspace(target)).toThrow(/delete|remove/i);
    expect(existsSync(unowned)).toBe(true);
  });

  it('treats a recorded control workspace that no longer exists as already removed', () => {
    const { target } = tempTarget();
    const swept = mkdtempSync(join(tmpdir(), 'coredoc-intent-control-swept-'));
    rmSync(swept, { recursive: true, force: true });
    recordControl(target, swept);

    expect(removeRecordedControlWorkspace(target)).toBeNull();
  });

  it('does nothing when no setup record exists yet', () => {
    const { target } = tempTarget();
    expect(removeRecordedControlWorkspace(target)).toBeNull();
  });

  it('does nothing for a record written before control copies were recorded', () => {
    const { target } = tempTarget();
    mkdirSync(target.workspaceRoot, { recursive: true });
    writeFileSync(setupResultPath(target), JSON.stringify({ projectId: 'intent-eval' }, null, 2));
    expect(removeRecordedControlWorkspace(target)).toBeNull();
  });

  it('refuses a recorded path in neither zone instead of deleting it', () => {
    const { target } = tempTarget();
    recordControl(target, OUTSIDE_BOTH_ZONES);
    expect(() => removeRecordedControlWorkspace(target)).toThrow(/control workspace|refuses/i);
    expect(existsSync(OUTSIDE_BOTH_ZONES)).toBe(true);
  });
});

// The real Acceptance-1 evidence: a full setup against the built CLI. No model
// calls, but it does parse and push, so it is skipped when the dist is absent
// rather than failing a suite run on an unbuilt tree. It runs against the
// suite's OWN temp target — never the shared corpus a gate run is standing on.
describe.skipIf(!existsSync(CLI_ENTRY))('runSetup', () => {
  it('seeds the graph, stages the traps, and asserts them through the CLI', async () => {
    const { target } = tempTarget();
    const first = await runSetup(target);
    disposable(() => rmSync(first.controlWorkspaceRoot, { recursive: true, force: true }));
    expect(first.report.anchorCounts.changed).toBeGreaterThanOrEqual(1);
    expect(first.report.anchorCounts.matched).toBeGreaterThanOrEqual(1);
    expect(Object.values(first.report.snapshotFreshness)).toContain('stale');
    expect(first.graphCommit).toBeTruthy();
    expect(first.headCommit).not.toBe(first.graphCommit);
    expect(existsSync(first.controlRepoRoot)).toBe(true);

    const second = await runSetup(target);
    disposable(() => rmSync(second.controlWorkspaceRoot, { recursive: true, force: true }));
    // The overlay sha is a copy of a committed file, so repeating it proves
    // nothing about the pipeline. The GRAPH the second run produced is the
    // artefact under test (review P3-11).
    expect(second.graphFingerprint).toEqual(first.graphFingerprint);
    expect(second.report.anchorCounts).toEqual(first.report.anchorCounts);
    expect(second.report.byAuthority).toEqual(first.report.byAuthority);
    expect(second.overlaySha256).toBe(first.overlaySha256);
    // Commits are NOT reproducible (timestamps differ); only the relationship
    // between them is asserted — HEAD stays deliberately ahead of the graph.
    expect(second.headCommit).not.toBe(second.graphCommit);
    // Every setup recreates the control copy and drops the previous one.
    expect(second.controlWorkspaceRoot).not.toBe(first.controlWorkspaceRoot);
    expect(existsSync(first.controlWorkspaceRoot)).toBe(false);
  }, 600_000);
});

/**
 * FIX 3's regression: this suite used to run the real staging against
 * `evals/cases-intent/workspace*` and the shared db, so `pnpm --dir evals test`
 * during a gate run re-staged the corpus and deleted `setup-result.json`. The
 * suite must be safe to run at ANY time.
 */
describe('the shared corpus is not the suite\'s to touch', () => {
  const sharedTarget = resolveIntentEvalTarget({ ...process.env, COREDOC_INTENT_EVAL_PROJECT: 'intent-eval' });
  const fingerprint = (): string => {
    const parts: string[] = [];
    for (const path of [setupResultPath(sharedTarget), sharedTarget.intentPath]) {
      parts.push(`${path}:${existsSync(path) ? sha256(readFileSync(path, 'utf8')) : 'absent'}`);
    }
    return parts.join('\n');
  };

  it('leaves setup-result.json and the staged overlay byte-identical across real staging', () => {
    const before = fingerprint();
    const { target } = tempTarget();
    stageWorkspace(target);
    const control = stageControlCopy(target);
    disposable(() => rmSync(control.controlWorkspaceRoot, { recursive: true, force: true }));
    expect(fingerprint()).toBe(before);
  });

  it('stages nothing inside evals/cases-intent/', () => {
    const { target } = tempTarget();
    stageWorkspace(target);
    const control = stageControlCopy(target);
    disposable(() => rmSync(control.controlWorkspaceRoot, { recursive: true, force: true }));
    const cases = realpathSync(CASES_INTENT_DIR) + sep;
    for (const path of [target.workspaceRoot, target.repoRoot, control.controlWorkspaceRoot]) {
      expect(realpathSync(path).startsWith(cases)).toBe(false);
    }
  });
});
