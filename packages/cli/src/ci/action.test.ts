import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const action = parse(readFileSync(new URL('../../../../action.yml', import.meta.url), 'utf8')) as {
  inputs: Record<string, { default?: string }>;
  runs: { steps: Array<{ name: string; if: string; run: string; env: Record<string, string> }> };
};

// These action expressions use the shared JS/GitHub subset: comparisons,
// && and ||. Evaluate the actual YAML, so credential and mode wiring is tested
// together rather than repeating an expected input shape.
function evaluate(expression: string, inputs: Record<string, string>): unknown {
  const source = expression
    .replace(/^\$\{\{\s*|\s*\}\}$/g, '')
    .replace(/inputs\.([a-z-]+)/g, (_, name: string) => `inputs["${name}"]`);
  return runInNewContext(source, { inputs });
}

describe('action uses one CI token with an explicit release opt-in', () => {
  for (const image of ['', 'test-image']) {
    it(`publishes without release by default in ${image ? 'Docker' : 'bundle'} mode`, () => {
      const inputs = Object.fromEntries(
        Object.entries(action.inputs).map(([key, value]) => [key, value.default ?? '']),
      );
      Object.assign(inputs, { image, token: 'cdt_ci', 'profile-path': '.coredoc/profile.ts' });
      const active = action.runs.steps.filter((step) => evaluate(step.if, inputs));
      expect(active).toHaveLength(1);
      expect(evaluate(active[0].env.COREDOC_TOKEN, inputs)).toBe('cdt_ci');
      expect(evaluate(active[0].env.COREDOC_PROFILE_PATH, inputs)).toBe('.coredoc/profile.ts');
      if (image) expect(active[0].run).toContain('-e COREDOC_TOKEN');
      inputs['intent-release'] = 'true';
      const deploying = action.runs.steps.filter((step) => evaluate(step.if, inputs));
      expect(deploying).toHaveLength(2);
      expect(evaluate(deploying[1].env.COREDOC_TOKEN, inputs)).toBe('cdt_ci');
      inputs['dry-run'] = 'true';
      expect(action.runs.steps.filter((step) => evaluate(step.if, inputs))).toHaveLength(1);
    });
  }

  it('has valid bash in every action step', () => {
    for (const step of action.runs.steps) {
      const check = spawnSync('bash', ['-n'], { input: step.run, encoding: 'utf8' });
      expect(check.status, `${step.name}: ${check.stderr}`).toBe(0);
    }
  });

  it('installs only explicitly selected indexers before a single dry-run parse', () => {
    const work = mkdtempSync(join(tmpdir(), 'action-install-'));
    try {
      writeFileSync(join(work, 'coredoc-cli.mjs'), 'console.log(JSON.stringify(process.argv.slice(2)))');
      const step = action.runs.steps.find((step) => step.name === 'Run Coredoc CI (bundle)')!;
      // The downloaded CLI is a recorder; execute the real action's post-download commands.
      const commands = step.run.slice(step.run.indexOf('TOOLS="$COREDOC_INSTALL_TOOLS"'));
      const run = (tools: string) =>
        spawnSync('bash', ['-eu', '-c', commands], {
          encoding: 'utf8',
          env: {
            PATH: process.env.PATH,
            RUNNER_TEMP: work,
            COREDOC_INSTALL_TOOLS: tools,
            COREDOC_INSTALL_CSHARP_TOOLS: 'false',
            COREDOC_REPO_NAME: 'mixed',
            COREDOC_PUSH_TIMEOUT: '15',
            DRY_RUN_ARG: '--dry-run',
          },
        });
      const requested = run('ruby python');
      expect(requested.status, requested.stderr).toBe(0);
      expect(
        requested.stdout
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line)),
      ).toEqual([
        ['tools', 'install', 'ruby'],
        ['tools', 'install', 'python'],
        ['ci', 'run', '-r', 'mixed', '--push-timeout', '15', '--dry-run'],
      ]);
      expect(run('').stdout.trim().split('\n')).toHaveLength(1);
      expect(run('unrecognized').status).toBe(1);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
