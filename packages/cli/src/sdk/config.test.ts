import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { loadConfig, repoRefKey } from '@coredoc/core/utils';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'sdk-config-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('sdk loadConfig', () => {
  it('keys resolvedRepoPaths by repoRefKey(projectId, repoName)', () => {
    const configPath = join(tmp, 'coredoc.config.json');
    mkdirSync(join(tmp, 'svc-a'), { recursive: true });
    mkdirSync(join(tmp, 'svc-b'), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          version: '2.0',
          projects: [
            {
              id: 'alpha',
              name: 'Alpha',
              repos: [
                { name: 'svc-a', path: './svc-a', type: 'backend' },
                { name: 'svc-b', path: './svc-b', type: 'backend' },
              ],
            },
          ],
          output: { dir: './out', format: 'json' },
          parserStorage: './parsers',
          agentMode: 'interactive',
        },
        null,
        2,
      ),
      'utf-8',
    );

    const result = loadConfig(configPath);

    expect(result.resolvedRepoPaths.get(repoRefKey('alpha', 'svc-a'))).toBe(resolve(tmp, 'svc-a'));
    expect(result.resolvedRepoPaths.get(repoRefKey('alpha', 'svc-b'))).toBe(resolve(tmp, 'svc-b'));
    expect(result.resolvedRepoPaths.get('svc-a')).toBeUndefined();
  });
});
