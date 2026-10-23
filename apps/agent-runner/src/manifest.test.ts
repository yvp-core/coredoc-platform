import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadManifest } from './manifest.js';

describe('loadManifest', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'runner-manifest-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('without a manifest file uses the platform defaults and reports no digest', async () => {
    const loaded = await loadManifest({ COREDOC_RUNNER_MANIFEST: join(dir, 'missing.json') }, '/opt/coredoc-workflows');
    expect(loaded).toEqual({
      manifest: {
        plugins: [{ path: '/opt/coredoc-workflows' }],
        tools: { jira: [] },
        phases: { scope: {}, implement: {} },
      },
      digest: null,
    });
  });

  it('reports the file’s digest, and refuses an invalid file instead of falling back to the defaults', async () => {
    const valid = join(dir, 'valid.json');
    await writeFile(valid, '{"version":1}');
    // sha256 of the file's bytes, computed independently with `shasum -a 256`.
    expect((await loadManifest({ COREDOC_RUNNER_MANIFEST: valid }, '/opt/x')).digest).toBe(
      'sha256:2430f1a2ad2982d0067885488a4c89e21ad1d7c83b115ba8f1b20acc88dfaea8',
    );
    const invalid = join(dir, 'invalid.json');
    await writeFile(invalid, '{"version":2}');
    await expect(loadManifest({ COREDOC_RUNNER_MANIFEST: invalid }, '/opt/x')).rejects.toThrow(/manifest is invalid/);
  });
});
