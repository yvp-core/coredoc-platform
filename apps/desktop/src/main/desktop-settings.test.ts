import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { defaultDesktopSettingsFile, readDesktopSettings, writeDesktopServerUrl } from './desktop-settings.js';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'coredoc-settings-'));
  file = join(dir, 'desktop-settings.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('readDesktopSettings', () => {
  it('reports no choice when the file is absent', () => {
    expect(readDesktopSettings(file)).toEqual({ serverUrl: null });
  });

  it('reports no choice when the file is corrupt', () => {
    writeFileSync(file, '{ broken');
    expect(readDesktopSettings(file)).toEqual({ serverUrl: null });
  });

  it('reads a persisted server URL', () => {
    writeFileSync(file, JSON.stringify({ serverUrl: 'https://coredoc.corp.example' }));
    expect(readDesktopSettings(file)).toEqual({ serverUrl: 'https://coredoc.corp.example' });
  });

  it('ignores a non-string serverUrl', () => {
    writeFileSync(file, JSON.stringify({ serverUrl: 7 }));
    expect(readDesktopSettings(file)).toEqual({ serverUrl: null });
  });
});

describe('writeDesktopServerUrl', () => {
  it('creates the file, parent directory included', () => {
    const nested = join(dir, 'nested', 'desktop-settings.json');
    writeDesktopServerUrl('https://coredoc.corp.example', nested);
    expect(readDesktopSettings(nested)).toEqual({ serverUrl: 'https://coredoc.corp.example' });
  });

  it('overwrites the previous choice and preserves unrelated keys', () => {
    writeFileSync(file, JSON.stringify({ serverUrl: 'https://old.example', somethingElse: true }));
    writeDesktopServerUrl('https://new.example', file);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      serverUrl: 'https://new.example',
      somethingElse: true,
    });
  });
});

describe('defaultDesktopSettingsFile', () => {
  it('lives next to credentials.json in the coredoc home, under its own name', () => {
    expect(defaultDesktopSettingsFile().endsWith('desktop-settings.json')).toBe(true);
  });
});
