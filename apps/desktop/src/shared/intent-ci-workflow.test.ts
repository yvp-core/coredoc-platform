import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { intentCiWorkflow } from './intent-ci-workflow';
import { IntentReleaseTrigger } from './intent-release-types';

const input = {
  repoName: 'service',
  intentRepoKey: 'github.com/acme/linked-identity',
  productionBranch: 'production',
  trigger: IntentReleaseTrigger.Merge,
  serverUrl: 'https://example.test',
};
describe('intent CI setup', () => {
  it('indexes the configured branch and syncs bindings without a deploy release', () => {
    const snippet = intentCiWorkflow(input);
    const workflow = parse(snippet.graph);
    expect(workflow.on.push.branches).toEqual(['production']);
    const action = workflow.jobs.coredoc.steps.at(-1).with;
    expect(action['intent-repo-key']).toBe(input.intentRepoKey);
    expect(workflow.concurrency['cancel-in-progress']).toBe(false);
    expect(action.token).toBe(`\${{ secrets.COREDOC_TOKEN }}`);
    expect(action['intent-release']).toBeUndefined();
    expect(action['profile-path']).toBe('.coredoc/profile.ts');
    expect(action['server-url']).toBe(input.serverUrl);
    expect(snippet.deploymentStep).toBeUndefined();
  });
  it('separates graph publish from deployment evidence, using the deployed revision', () => {
    const snippet = intentCiWorkflow({ ...input, trigger: IntentReleaseTrigger.Deploy });
    expect(parse(snippet.graph).jobs.coredoc.steps.at(-1).with['intent-release']).toBeUndefined();
    const steps = parse(snippet.deploymentStep!);
    expect(steps[0].env.DEPLOYED_SHA).toBe(`\${{ steps.deploy.outputs.deployed_sha }}`);
    expect(steps[0].run).toContain('test -n');
    const step = steps[1];
    expect(step.with['deploy-ref']).toBe(`\${{ steps.deploy.outputs.deployed_sha }}`);
    expect(step.with['intent-release']).toBe('true');
    expect(step.with.token).toBe(`\${{ secrets.COREDOC_TOKEN }}`);
  });
  it('does not guess main when no production branch is configured', () => {
    const workflow = parse(intentCiWorkflow({ ...input, productionBranch: null }).graph);
    expect(workflow.on).toEqual({ workflow_dispatch: null });
  });

  it('generates GitLab graph jobs with saved identity, branch and executable shell', () => {
    const snippet = intentCiWorkflow({ ...input, platform: 'gitlab' });
    const workflow = parse(snippet.graph);
    const job = workflow.coredoc;
    expect(workflow.stages).toContain(job.stage);
    expect(['.pre', '.post']).not.toContain(job.stage);
    expect(job.variables.COREDOC_REPO_NAME).toBe(input.repoName);
    expect(job.variables.COREDOC_SERVER_URL).toBe(input.serverUrl);
    expect(job.rules[0].if).toBe(
      '$CI_PIPELINE_SOURCE == "push" && $CI_COMMIT_BRANCH == "production" && $CI_COMMIT_REF_PROTECTED == "true"',
    );
    expect(job.rules[1].if).toBe(
      '$CI_PIPELINE_SOURCE == "web" && $CI_COMMIT_BRANCH == "production" && $CI_COMMIT_REF_PROTECTED == "true"',
    );
    expect(job.resource_group).toBe('coredoc-$CI_PROJECT_ID');
    expect(snippet.graph).not.toContain('${{ github.');
    for (const script of [...job.before_script, ...job.script]) {
      expect(spawnSync('bash', ['-n'], { input: script, encoding: 'utf8' }).status).toBe(0);
    }
    expect(job.script.join('\n')).toContain('sha256sum --check');
    expect(job.script.join('\n')).toContain('ci run --repo "$COREDOC_REPO_NAME"');
  });

  it('keeps GitLab bootstrap manual and never claims a push is deployment evidence', () => {
    const snippet = intentCiWorkflow({
      ...input,
      platform: 'gitlab',
      productionBranch: null,
      trigger: IntentReleaseTrigger.Deploy,
    });
    expect(parse(snippet.graph).coredoc.rules).toEqual([
      { if: '$CI_PIPELINE_SOURCE == "web" && $CI_COMMIT_REF_PROTECTED == "true"', when: 'manual' },
    ]);
    expect(snippet.deploymentStep).toBeUndefined();
    expect(snippet.deploymentNote).toContain('GitLab');
  });
  it('installs dependencies in a separate job that refuses a visible Coredoc token', () => {
    const workflow = parse(intentCiWorkflow({ ...input, platform: 'gitlab' }).graph);
    const setup = workflow['coredoc-dependencies'];
    expect(setup).toBeDefined();
    expect(setup.environment).toBeUndefined();
    expect(setup.inherit).toEqual({ default: false });
    expect(workflow.coredoc.environment).toEqual({ name: 'coredoc-publish', action: 'access' });
    expect(workflow.coredoc.needs).toEqual([{ job: 'coredoc-dependencies', artifacts: true }]);
    expect(workflow.coredoc.before_script.join('\n')).not.toContain('npm ci');
    expect(setup.rules.map((rule: { if: string }) => rule.if)).toEqual(
      workflow.coredoc.rules.map((rule: { if: string }) => rule.if),
    );
    const shell = setup.script.join('\n');
    expect(spawnSync('bash', ['-n'], { input: shell }).status).toBe(0);
    const root = mkdtempSync(join(tmpdir(), 'gitlab-dependencies-'));
    const marker = join(root, 'dependencies-installed');
    try {
      writeFileSync(join(root, 'package-lock.json'), '{}');
      writeFileSync(
        join(root, 'npm'),
        '#!/bin/sh\ntest -z "$COREDOC_TOKEN" || exit 41\nprintf installed > dependencies-installed\n',
        { mode: 0o755 },
      );
      // Use only a dummy token. The guard must precede even the first package invocation.
      const bad = spawnSync('/bin/bash', ['-e', '-c', shell], {
        cwd: root,
        env: { PATH: root + ':/usr/bin:/bin', COREDOC_TOKEN: 'dummy-only' },
        encoding: 'utf8',
      });
      expect(bad.status).not.toBe(0);
      expect(bad.stdout + bad.stderr).toContain('coredoc-publish');
      expect(bad.stdout + bad.stderr).not.toContain('dummy-only');
      expect(existsSync(marker)).toBe(false);
      const good = spawnSync('/bin/bash', ['-e', '-c', shell], {
        cwd: root,
        env: { PATH: root + ':/usr/bin:/bin' },
        encoding: 'utf8',
      });
      expect(good.status, good.stderr).toBe(0);
      expect(existsSync(marker)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
