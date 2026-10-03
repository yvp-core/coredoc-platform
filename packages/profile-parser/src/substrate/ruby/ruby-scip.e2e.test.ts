/**
 * Live standalone scip-ruby + full parse, including explicit installation and source isolation.
 * Opt-in because it downloads a release and invokes the OS sandbox.
 */
import { rubyProvider } from '../../providers/ruby.js';
import { cpSync, mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RubyProfile } from '../../types/ruby-profile.js';
import { installRubyTool } from './scip-tool.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__/sample-app');
const PROFILE: RubyProfile = { parserId: 'ruby-test', substrate: { language: 'ruby', include: [] } };

const RUN = process.env.COREDOC_SCIP_RUBY_E2E === '1';
const d = RUN ? describe : describe.skip;

d('scip-ruby live e2e (standalone, no Gemfile)', () => {
  let work: string;
  let home: string;

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'scip-ruby-e2e-'));
    home = mkdtempSync(join(tmpdir(), 'scip-ruby-tools-'));
    vi.stubEnv('COREDOC_HOME', home);
    cpSync(FIXTURE, work, { recursive: true });
    rmSync(join(work, 'index.scip'), { force: true }); // regenerate from scratch
    rmSync(join(work, 'Gemfile'), { force: true });
    rmSync(join(work, 'Gemfile.lock'), { force: true });
    await installRubyTool(work);
  }, 180_000);

  afterAll(() => {
    if (work) rmSync(work, { recursive: true, force: true });
    if (home) rmSync(home, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it('runs scip-ruby for real and emits scip-provenance Tier-A edges on canonical method ids', async () => {
    const before = readdirSync(work, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => [join(e.parentPath, e.name), readFileSync(join(e.parentPath, e.name))] as const);
    const ruby = await rubyProvider.parse(PROFILE, { repoRoot: work, repoName: 'sample-app', repoKey: 'sample-app' });
    const nameById = new Map(ruby.functions.map((f) => [f.id, f.name]));
    const scipEdges = ruby.calls.filter((e) => e.provenance === 'scip');
    const pairs = new Set(scipEdges.map((e) => `${nameById.get(e.callerId)}->${nameById.get(e.calleeId)}`));
    expect(scipEdges.length).toBeGreaterThanOrEqual(3);
    expect(pairs.has('build->validate!')).toBe(true);
    expect(pairs.has('validate!->normalize')).toBe(true);
    for (const [path, bytes] of before) expect(readFileSync(path)).toEqual(bytes);
    expect(readdirSync(work, { recursive: true, withFileTypes: true }).filter((e) => e.isFile())).toHaveLength(
      before.length,
    );
  }, 180_000);
});
