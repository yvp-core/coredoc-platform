/**
 * Whole-output invariant suite for the Zig substrate (AC-4).
 *
 * The fixture-based tests assert exact nodes on hand-written shapes; a walker that only
 * understands those shapes would still pass them. This file asserts PROPERTIES over a real
 * Zig repository of a few hundred files: id uniqueness and parseability, every join
 * (`fileId`, `classId`, `methods[]`) resolving, no empty names, honest stats, and
 * determinism across two parses.
 *
 * The repo is external (too large to vendor), so the suite is gated on
 * `COREDOC_ZIG_FIXTURE_REPO` or a sibling checkout and PRINTS its skip reason — a suite that
 * can silently vanish is not evidence.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StableIdGenerator } from '@coredoc/core';
import { TreeSitterLoader } from '../../tree-sitter/tree-sitter-loader.js';
import { describe, expect, it } from 'vitest';
import { checkReferentialIntegrity } from '../../integrity/referential-integrity.js';
import { type ZigParsedRepo, discoverZigFileScope, parseZigRepo, toFullParsedRepo } from './zig-parser.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../../..');
const FIXTURE_REPO = process.env.COREDOC_ZIG_FIXTURE_REPO ?? resolve(REPO_ROOT, '..', 'browser');
const AVAILABLE = existsSync(FIXTURE_REPO) && existsSync(join(FIXTURE_REPO, 'build.zig.zon'));

if (!AVAILABLE) {
  console.warn(
    `[zig-invariants] SKIPPED: no Zig fixture repo at ${FIXTURE_REPO}. ` +
      'Set COREDOC_ZIG_FIXTURE_REPO to a Zig checkout (a directory with build.zig.zon) to run it.',
  );
}

const REPO_NAME = 'zig-fixture';

/** The five tiers BR-12 defines: a provenance outside them is another language's edge. */
const ZIG_PROVENANCE = new Set(['zig-local', 'zig-self', 'zig-type', 'zig-import', 'zig-field']);

describe.skipIf(!AVAILABLE)('zig substrate — whole-output invariants on a real repo', () => {
  const idGen = new StableIdGenerator(FIXTURE_REPO, REPO_NAME);
  let repo: ZigParsedRepo;

  it('parses the fixture repo and reports its shape', async () => {
    const started = Date.now();
    repo = await parseZigRepo(FIXTURE_REPO, REPO_NAME, {});
    const elapsed = Date.now() - started;
    console.info(
      `[zig-invariants] ${FIXTURE_REPO}: files=${repo.files.length} classes=${repo.classes.length} ` +
        `enums=${repo.enums.length} functions=${repo.functions.length} ` +
        `skipped=${repo.parseStats.skippedFiles} wallMs=${elapsed}`,
    );
    expect(repo.files.length).toBeGreaterThan(50);
    expect(repo.classes.length).toBeGreaterThan(0);
    expect(repo.functions.length).toBeGreaterThan(0);
  }, 600_000);

  it('mints every id through StableIdGenerator, uniquely', () => {
    const ids = [
      ...repo.files.map((f) => f.id),
      ...repo.packages.map((p) => p.id),
      ...repo.classes.map((c) => c.id),
      ...repo.enums.map((e) => e.id),
      ...repo.functions.map((f) => f.id),
    ];
    expect(new Set(ids).size).toBe(ids.length);
    // Property ids share the id space and are minted per class + field name: a phantom or a
    // mislabelled tuple field collapses several fields onto one id.
    const propertyIds = repo.classes.flatMap((c) => c.properties.map((p) => p.id));
    const duplicateProps = propertyIds.filter((id, i) => propertyIds.indexOf(id) !== i);
    expect(duplicateProps).toEqual([]);
    for (const id of ids) {
      const parsed = idGen.parseId(id);
      expect(parsed, id).not.toBeNull();
      expect(parsed?.repoHash, id).toBe(repo.id);
      expect(idGen.belongsToRepo(id), id).toBe(true);
    }
  });

  it('resolves every structural join', () => {
    const fileIds = new Set(repo.files.map((f) => f.id));
    const classIds = new Set(repo.classes.map((c) => c.id));
    const functionIds = new Set(repo.functions.map((f) => f.id));
    const packageIds = new Set(repo.packages.map((p) => p.id));

    for (const f of repo.files) expect(packageIds.has(f.packageId ?? ''), f.path).toBe(true);
    for (const c of repo.classes) expect(fileIds.has(c.fileId), c.id).toBe(true);
    for (const e of repo.enums) expect(fileIds.has(e.fileId), e.id).toBe(true);
    for (const fn of repo.functions) {
      expect(fileIds.has(fn.fileId), fn.id).toBe(true);
      if (fn.classId !== undefined) expect(classIds.has(fn.classId), fn.id).toBe(true);
      expect(fn.kind === 'method', fn.id).toBe(fn.classId !== undefined);
    }
    for (const c of repo.classes) {
      for (const methodId of c.methods) expect(functionIds.has(methodId), methodId).toBe(true);
    }
  });

  it('names every node and reports honest stats', () => {
    for (const node of [...repo.classes, ...repo.enums, ...repo.functions]) {
      expect(node.name.trim().length, node.id).toBeGreaterThan(0);
      expect(node.location.filePath.length, node.id).toBeGreaterThan(0);
      expect(node.location.startLine, node.id).toBeGreaterThan(0);
    }
    for (const cls of repo.classes) {
      for (const prop of cls.properties) expect(prop.name.trim().length, prop.id).toBeGreaterThan(0);
    }
    for (const e of repo.enums) {
      for (const member of e.members) expect(member.name.trim().length, `${e.id}.${member.name}`).toBeGreaterThan(0);
    }
    expect(repo.parseStats.parsedFiles).toBe(repo.files.length);
    expect(repo.parseStats.totalFiles).toBe(repo.files.length + repo.parseStats.skippedFiles);
  });

  it('passes referential integrity as a full ParsedRepo', () => {
    const full = toFullParsedRepo(repo, FIXTURE_REPO, 'zig-fixture-v1', new Date(0).toISOString());
    const report = checkReferentialIntegrity(full);
    expect(report.violations).toEqual([]);
    expect(report.danglingRefs).toBe(0);
  });

  it('is deterministic: a second parse yields the identical stable-id set', async () => {
    const again = await parseZigRepo(FIXTURE_REPO, REPO_NAME, {});
    // Every collection, not just the slice-1 three: a resolver that iterates a Map in insertion
    // order is deterministic only as long as the walk that filled it is.
    const idsOf = (r: ZigParsedRepo) =>
      [
        ...r.classes.map((c) => c.id),
        ...r.enums.map((e) => e.id),
        ...r.functions.map((f) => f.id),
        ...r.variables.map((v) => v.id),
        ...r.typeAliases.map((t) => t.id),
        ...r.imports.map((i) => i.id),
        ...r.calls.map((c) => c.id),
        ...r.entrypoints.map((e) => e.id),
        ...r.entities.map((e) => e.id),
        ...r.dbOperations.map((o) => o.id),
        ...r.externalCalls.map((e) => e.id),
      ].sort();
    expect(idsOf(again)).toEqual(idsOf(repo));
    expect(again.id).toBe(repo.id);
  }, 600_000);

  it("resolves every graph join (AC-4')", () => {
    const fileIds = new Set(repo.files.map((f) => f.id));
    const functionIds = new Set(repo.functions.map((f) => f.id));
    const entityIds = new Set(repo.entities.map((e) => e.id));

    for (const call of repo.calls) {
      expect(functionIds.has(call.callerId), call.id).toBe(true);
      expect(functionIds.has(call.calleeId ?? ''), call.id).toBe(true);
      expect(ZIG_PROVENANCE.has(call.provenance ?? ''), call.id).toBe(true);
    }
    for (const entrypoint of repo.entrypoints)
      expect(functionIds.has(entrypoint.handlerId ?? ''), entrypoint.id).toBe(true);
    for (const edge of repo.externalCalls) expect(functionIds.has(edge.callerId), edge.id).toBe(true);
    for (const op of repo.dbOperations) {
      expect(functionIds.has(op.performerId), op.id).toBe(true);
      if (op.entityId !== undefined) expect(entityIds.has(op.entityId), op.id).toBe(true);
    }
    for (const edge of repo.imports) {
      expect(fileIds.has(edge.sourceFileId), edge.id).toBe(true);
      if (edge.targetFileId !== undefined) expect(fileIds.has(edge.targetFileId), edge.id).toBe(true);
    }
    for (const node of [...repo.variables, ...repo.typeAliases, ...repo.entities]) {
      expect(fileIds.has(node.fileId), node.id).toBe(true);
    }
  });

  it('mints every graph id uniquely', () => {
    const ids = [
      ...repo.variables.map((v) => v.id),
      ...repo.typeAliases.map((t) => t.id),
      ...repo.imports.map((i) => i.id),
      ...repo.calls.map((c) => c.id),
      ...repo.entrypoints.map((e) => e.id),
      ...repo.entities.map((e) => e.id),
      ...repo.dbOperations.map((o) => o.id),
      ...repo.externalCalls.map((e) => e.id),
    ];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps the build script and the build output out of scope (D1)', () => {
    // GROUND TRUTH (`browser`, 2026-09-15): 574 in-scope `.zig` files — 575 minus `build.zig`.
    // Asserted as a PROPERTY rather than the count, so a fixture checkout that moves on still
    // proves the policy: no build script, no build-output tree, ever a parsed source file.
    const paths = repo.files.map((f) => f.path);
    expect(paths).not.toContain('build.zig');
    expect(paths.filter((p) => /(^|\/)(zig-out|\.?zig-cache)\//.test(p))).toEqual([]);
    // …and `build.zig`'s own `pub fn build` is therefore not a function, not a caller, not an
    // entrypoint and not an `@import` target.
    expect(repo.entrypoints.map((e) => (e.details as { command: string }).command)).not.toContain('build');
  });

  it('finds the executables `build.zig` names and the module it declares', () => {
    const commands = repo.entrypoints.map((e) => ({
      command: (e.details as { command: string }).command,
      path: e.location.filePath,
    }));
    expect(commands).toContainEqual({ command: 'lightpanda', path: 'src/main.zig' });
    // GROUND TRUTH (`browser`, 2026-09-15): the three `build.zig` executables plus the two
    // `pub fn main` files no exe claims, which fall back to their basename (BR-13).
    // `orderfile/mark_hot_sections.zig` is a real standalone tool and is NOT under an excluded
    // directory, so it stays an entrypoint after the D1 exclude policy.
    expect(commands.map((c) => c.command).sort()).toEqual([
      'lightpanda',
      'lightpanda-skills',
      'lightpanda-snapshot-creator',
      'mark_hot_sections',
      'test_runner',
    ]);
    for (const entrypoint of repo.entrypoints) expect(entrypoint.type).toBe('cli');

    const moduleImports = repo.imports.filter((i) => i.moduleSpecifier === 'lightpanda');
    expect(moduleImports.length).toBeGreaterThan(0);
    expect(moduleImports.some((i) => i.targetFileId !== undefined)).toBe(true);
  });

  it('reads the real schema and nothing a `test` block declares', () => {
    const tables = repo.entities.map((e) => e.tableName);
    expect(tables).toContain('cache');
    expect(tables).toContain('header');
    expect(tables).not.toContain('test');
    expect(tables).not.toContain('pool_test');
    for (const entity of repo.entities) expect(entity.ormType).toBe('sql');
  });

  it('keeps the formatted statements a DB verb executes one hop later (BR-15)', () => {
    // GROUND TRUTH (`browser`, 2026-09-14): `src/browser/webapi/storage/idb/Engine.zig` builds
    // six `idb_index_records` statements with `std.fmt.bufPrint` into a local and hands that
    // local to `conn.exec`/`row`/`scalar`/`rows`. Gating on the IMMEDIATE callee lost all six.
    const histogram = new Map<string, number>();
    for (const op of repo.dbOperations) histogram.set(op.entityName, (histogram.get(op.entityName) ?? 0) + 1);
    console.info(`[zig-invariants] dbOperations by entity: ${JSON.stringify([...histogram].sort())}`);

    const indexRecordOps = repo.dbOperations.filter((op) => op.entityName === 'idb_index_records');
    expect(indexRecordOps.length).toBeGreaterThan(0);
    expect(indexRecordOps.map((op) => op.operation)).toContain('read');
    // The log/format decoys the gate exists for stay out.
    expect([...histogram.keys()]).not.toContain('err');
    expect([...histogram.keys()]).not.toContain('pool_test');
    // Every operated table is one the schema declares — RT4's bare lowercased name joins them.
    const declared = new Set(repo.entities.map((e) => e.tableName.toLowerCase()));
    expect([...histogram.keys()].filter((t) => !declared.has(t))).toEqual([]);
  });

  it('emits the ground-truth `std.http.Client` egress edge, const-folded URL and all', () => {
    // GROUND TRUTH (`browser`, 2026-09-14): `src/agent/auth/models_dev.zig:111` fetches
    // `.url = api_url` where `const api_url = "https://models.dev/api.json"` sits at `:30`.
    // The `codex.zig` sites stay DROPPED on purpose: their URL is a function parameter
    // (LIM-B/LIM-D), which no amount of one-hop folding can read.
    const byId = new Map(repo.functions.map((fn) => [fn.id, fn]));
    const described = repo.externalCalls.map(
      (e) => `${e.targetDescriptor?.http?.pathTemplate} @ ${byId.get(e.callerId)?.location.filePath}`,
    );
    console.info(`[zig-invariants] std.http egress: ${JSON.stringify(described)}`);

    expect(repo.externalCalls.length).toBeGreaterThanOrEqual(1);
    expect(described).toContain('/api.json @ src/agent/auth/models_dev.zig');
  });

  it('records the call-resolution rate (LIM-B)', () => {
    const { seen, resolved, byTier } = repo.callStats;
    console.info(
      `[zig-invariants] calls: seen=${seen} resolved=${resolved} ` +
        `rate=${((resolved / Math.max(seen, 1)) * 100).toFixed(1)}% byTier=${JSON.stringify(byTier)}`,
    );
    expect(resolved).toBe(repo.calls.length);
    expect(
      resolved / Math.max(seen, 1),
      'call resolution below the LIM-B floor: the expected band is 25-40 %, and a rate under 15 % ' +
        'means a tier regressed (or the grammar stopped parsing the receivers) — explain it in the PR',
    ).toBeGreaterThanOrEqual(0.15);
  });

  it('records (does not gate) how many files the bundled grammar cannot fully parse', async () => {
    const parser = await TreeSitterLoader.getInstance().getParser('zig');
    const scope = discoverZigFileScope(FIXTURE_REPO, []);
    let withErrors = 0;
    for (const rel of scope.included) {
      const tree = parser.parse(readFileSync(join(FIXTURE_REPO, rel), 'utf-8'));
      if (tree.rootNode.hasError) withErrors++;
      tree.delete?.();
    }
    console.info(
      `[zig-invariants] grammar recovery: ${withErrors}/${scope.included.length} files contain ERROR or missing nodes`,
    );
    expect(withErrors).toBeLessThan(scope.included.length);
  }, 600_000);
});
