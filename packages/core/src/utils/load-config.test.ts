import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { loadConfig } from './load-config.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'load-config-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeConfig(dir: string): string {
  const configPath = join(dir, 'coredoc.config.json');
  mkdirSync(join(dir, 'svc-a'), { recursive: true });
  writeFileSync(
    configPath,
    JSON.stringify({
      version: '2.0',
      projects: [{ id: 'alpha', name: 'Alpha', repos: [{ name: 'svc-a', path: './svc-a', type: 'backend' }] }],
      output: { dir: './out', format: 'json' },
      parserStorage: './parsers',
    }),
    'utf-8',
  );
  return configPath;
}

describe('loadConfig', () => {
  it('throws when the config file is missing', () => {
    expect(() => loadConfig(join(tmp, 'nope.json'))).toThrow(/Config file not found/);
  });

  it('resolves a relative config path against cwd', () => {
    writeConfig(tmp);
    // process.chdir() is unavailable under vitest workers.
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(tmp);
    try {
      expect(loadConfig('coredoc.config.json').configPath).toBe(resolve(tmp, 'coredoc.config.json'));
    } finally {
      cwd.mockRestore();
    }
  });
});
