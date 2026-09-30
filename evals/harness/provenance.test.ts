import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createRunManifest,
  fingerprintDirtyInput,
  fingerprintGraphBackend,
  fingerprintNamedPaths,
  fingerprintWorkingTree,
  recordPermissionCanaryEvidence,
} from './provenance.js';
import { createPermissionCanaryConfig, PERMISSION_CANARY_CONTRACT_VERSION, type PermissionCanaryEvidence } from './permission-canary.js';
import { AgentProvider, GraphBackend, JudgeMode } from './types.js';

const roots: string[] = [];
const SHA = '0123456789abcdef0123456789abcdef01234567';

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('dirty fingerprint', () => {
  it('hashes the full HEAD patch plus sorted untracked path/content pairs', () => {
    const a = fingerprintDirtyInput({
      trackedPatch: Buffer.from('binary patch'),
      untracked: [
        { path: 'z.bin', content: Buffer.from([0, 1, 2]) },
        { path: 'a.txt', content: Buffer.from('a') },
      ],
    });
    const reordered = fingerprintDirtyInput({
      trackedPatch: Buffer.from('binary patch'),
      untracked: [
        { path: 'a.txt', content: Buffer.from('a') },
        { path: 'z.bin', content: Buffer.from([0, 1, 2]) },
      ],
    });
    expect(reordered).toBe(a);
    expect(
      fingerprintDirtyInput({
        trackedPatch: Buffer.from('binary patch'),
        untracked: [{ path: 'a.txt', content: Buffer.from('changed') }],
      }),
    ).not.toBe(a);
  });

  it('does not let the host locale comparator change a dirty-tree hash', () => {
    const input = {
      trackedPatch: 'patch',
      untracked: [
        { path: 'i.txt', content: 'lower' },
        { path: 'I.txt', content: 'upper' },
      ],
    };
    const compare = vi.spyOn(String.prototype, 'localeCompare');
    try {
      compare.mockImplementation(function (other) {
        return String(this) < String(other) ? -1 : String(this) > String(other) ? 1 : 0;
      });
      const codeUnitHash = fingerprintDirtyInput(input);
      compare.mockImplementation(function (other) {
        return String(this) < String(other) ? 1 : String(this) > String(other) ? -1 : 0;
      });
      expect(fingerprintDirtyInput(input)).toBe(codeUnitHash);
    } finally {
      compare.mockRestore();
    }
  });

  it('fingerprints the effective tree versus HEAD and excludes ignored artifacts', () => {
    const repo = mkdtempSync(join(tmpdir(), 'eval-provenance-git-'));
    roots.push(repo);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
    git('init', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    writeFileSync(join(repo, '.gitignore'), 'runs/\n');
    writeFileSync(join(repo, 'tracked.txt'), 'base\n');
    git('add', '.gitignore', 'tracked.txt');
    git('commit', '-m', 'base');
    const clean = fingerprintWorkingTree(repo);
    writeFileSync(join(repo, 'tracked.txt'), 'staged\n');
    git('add', 'tracked.txt');
    writeFileSync(join(repo, 'tracked.txt'), 'working\n');
    writeFileSync(join(repo, 'new.bin'), Buffer.from([0, 255, 1]));
    const dirty = fingerprintWorkingTree(repo);
    expect(dirty).not.toBe(clean);
    mkdirSync(join(repo, 'runs'));
    writeFileSync(join(repo, 'runs', 'ignored.json'), '{}');
    expect(fingerprintWorkingTree(repo)).toBe(dirty);
  });
});

describe('graph fingerprint', () => {
  it('hashes sqlite main + present WAL but excludes SHM', async () => {
    const root = mkdtempSync(join(tmpdir(), 'eval-provenance-db-'));
    roots.push(root);
    const db = join(root, 'project.db');
    writeFileSync(db, 'main');
    writeFileSync(`${db}-wal`, 'wal');
    writeFileSync(`${db}-shm`, 'shm-one');
    const before = await fingerprintGraphBackend(GraphBackend.Sqlite, db);
    writeFileSync(`${db}-shm`, 'shm-two');
    expect((await fingerprintGraphBackend(GraphBackend.Sqlite, db)).fingerprint).toBe(
      before.fingerprint,
    );
    writeFileSync(`${db}-wal`, 'wal-two');
    expect((await fingerprintGraphBackend(GraphBackend.Sqlite, db)).fingerprint).not.toBe(
      before.fingerprint,
    );
    expect(before.components.map((item) => item.identity)).toEqual(['project.db', 'project.db-wal']);
  });

  it('hashes a Ladybug .lbdb file set in stable path order', async () => {
    const root = mkdtempSync(join(tmpdir(), 'eval-provenance-lb-'));
    roots.push(root);
    const db = join(root, 'project.lbdb');
    mkdirSync(join(db, 'nested'), { recursive: true });
    writeFileSync(join(db, 'z'), 'z');
    writeFileSync(join(db, 'nested', 'a'), 'a');
    const fingerprint = await fingerprintGraphBackend(GraphBackend.Ladybug, db);
    expect(fingerprint.components.map((item) => item.identity)).toEqual(['nested/a', 'z']);
  });
});

describe('combined source fingerprint', () => {
  it('identifies every named component and changes when shared verifier code changes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'eval-provenance-sources-'));
    roots.push(root);
    const casePath = join(root, 'case.ts');
    const verifierPath = join(root, 'verifier.ts');
    writeFileSync(casePath, 'export const caseDef = 1;');
    writeFileSync(verifierPath, 'export const score = 1;');
    const first = await fingerprintNamedPaths({ case: casePath, verifier: verifierPath });
    writeFileSync(verifierPath, 'export const score = 2;');
    const changed = await fingerprintNamedPaths({ case: casePath, verifier: verifierPath });
    expect(first).not.toBeNull();
    expect(changed).not.toBe(first);
    expect(await fingerprintNamedPaths({ case: casePath, missing: join(root, 'missing.ts') }))
      .toBeNull();
  });
});

describe('run manifest cohort', () => {
  const permissionCanaryConfig = createPermissionCanaryConfig({
    harnessHead: SHA,
    harnessDirtyFingerprint: 'dirty-a',
    mcpSchemaHash: null,
    mcpBuildHash: null,
    sdkRuntimeHash: 'sdk-runtime',
    model: 'claude-sonnet-5',
  });

  function manifestInput() {
    return {
      createdAt: '2026-08-23T00:00:00.000Z',
      harness: { head: SHA, dirtyFingerprint: 'dirty-a' },
      targets: [{
        manifestPath: '/targets/t.json',
        manifestHash: 'manifest',
        repoKey: 'target',
        requestedGitSha: SHA,
        actualVerifierGitSha: SHA,
        actualAgentGitSha: SHA,
      }],
      graph: {
        backend: GraphBackend.Ladybug,
        path: '/graph.lbdb',
        fingerprint: 'graph',
        repositories: [{ repoKey: 'target', parsedGitSha: SHA, parsedAt: null, parserVersion: null }],
      },
      cells: [{
        target: 'target',
        case: 'blast-radius',
        lifecycle: 'primary' as const,
        primaryVerifierId: 'acme-api-v1',
        promptHash: 'prompt-a',
        oracleHash: 'oracle-a',
        caseHash: 'case',
        verifierHash: 'verifier',
        repoRevisions: {},
      }],
      arms: [{
        arm: 'withMcp' as const,
        factors: { mcp: true, productGuide: true },
        systemPromptHash: 'system',
        skillHash: 'skill-a',
      }],
      mcp: {
        mcpSchemaHash: null,
        mcpBuildHash: null,
      },
      models: {
        provider: AgentProvider.Claude,
        agentModel: 'claude-sonnet-5',
        agentSdkVersion: '0.2.77',
        judgeProvider: 'codex',
        judgeModel: 'gpt-6-sol',
        judgeSdkVersion: null,
        judgeMode: JudgeMode.LegacyUngrounded,
      },
      permissionCanary: {
        config: permissionCanaryConfig,
        evidence: null,
      },
    } as const;
  }

  it('uses every controlled fingerprint in cohort identity and keeps unavailable values null', () => {
    const base = createRunManifest(manifestInput());
    const dirty = createRunManifest({
      ...manifestInput(),
      harness: { ...manifestInput().harness, dirtyFingerprint: 'dirty-b' },
    });
    const prompt = createRunManifest({
      ...manifestInput(),
      cells: [{ ...manifestInput().cells[0], promptHash: 'prompt-b' }],
    });
    const oracle = createRunManifest({
      ...manifestInput(),
      cells: [{ ...manifestInput().cells[0], oracleHash: 'oracle-b' }],
    });
    const skill = createRunManifest({
      ...manifestInput(),
      arms: [{ ...manifestInput().arms[0], skillHash: 'skill-b' }],
    });
    const verifierId = createRunManifest({
      ...manifestInput(),
      cells: [{
        ...manifestInput().cells[0],
        primaryVerifierId: 'acme-web-v1',
      }],
    });
    const canaryRuntime = createRunManifest({
      ...manifestInput(),
      permissionCanary: {
        config: createPermissionCanaryConfig({
          harnessHead: SHA,
          harnessDirtyFingerprint: 'dirty-a',
          mcpSchemaHash: null,
          mcpBuildHash: null,
          sdkRuntimeHash: 'different-sdk-runtime',
          model: 'claude-sonnet-5',
        }),
        evidence: null,
      },
    });
    expect(
      new Set([
        base.cohortId,
        dirty.cohortId,
        prompt.cohortId,
        oracle.cohortId,
        skill.cohortId,
        verifierId.cohortId,
        canaryRuntime.cohortId,
      ]),
    ).toHaveLength(7);
    expect(base.graph.repositories[0]?.parsedAt).toBeNull();
    expect(base.mcp.mcpSchemaHash).toBeNull();
    expect(base.graphFingerprintAfter).toBeNull();
    expect(base.graphChangedDuringRun).toBeNull();
    expect(base.oracleJudgeUsage).toBeNull();
  });

  it('records matching canary evidence without changing cohort identity and rejects stale material', () => {
    const manifest = createRunManifest(manifestInput());
    const evidence = {
      contractVersion: PERMISSION_CANARY_CONTRACT_VERSION,
      contractHash: permissionCanaryConfig.queryPolicyHash,
      promptHash: 'prompt',
      transcriptHash: 'transcript',
      transcriptRelativePath: 'permission-canary/transcript.json',
      materialFingerprint: permissionCanaryConfig.materialFingerprint,
      model: permissionCanaryConfig.model,
      passed: true,
      failureCodes: [],
      status: 'completed',
      costUsd: 0.01,
      init: {
        builtInTools: ['Glob', 'Grep', 'Read'],
        mcpTools: ['mcp__coredoc-eval__describe_repository'],
        mcpServers: [{ name: 'coredoc-eval', status: 'connected' }],
      },
      probes: [],
    } satisfies PermissionCanaryEvidence;
    const cohort = manifest.cohortId;
    recordPermissionCanaryEvidence(manifest, evidence);
    expect(manifest.permissionCanary.evidence).toEqual(evidence);
    expect(manifest.cohortId).toBe(cohort);
    expect(() =>
      recordPermissionCanaryEvidence(manifest, {
        ...evidence,
        materialFingerprint: 'stale-material',
      }),
    ).toThrow(/material fingerprint/i);
  });

  it('records every selected target, cell, and arm in one wave cohort', () => {
    const input = manifestInput();
    const manifest = createRunManifest({
      ...input,
      targets: [
        ...input.targets,
        { ...input.targets[0], repoKey: 'sibling', manifestPath: '/targets/s.json' },
      ],
      cells: [
        ...input.cells,
        { ...input.cells[0], target: 'sibling', case: 'type-impact' as const },
      ],
      arms: [
        ...input.arms,
        {
          arm: 'withoutMcp' as const,
          factors: { mcp: false, productGuide: false },
          systemPromptHash: 'control-system',
          skillHash: null,
        },
      ],
    });
    expect(manifest.targets.map((target) => target.repoKey)).toEqual(['target', 'sibling']);
    expect(manifest.cells).toHaveLength(2);
    expect(manifest.arms).toHaveLength(2);
  });
});
