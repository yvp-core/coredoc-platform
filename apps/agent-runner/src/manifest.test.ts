import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveManifest } from '@coredoc/core/agent-runner';
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
      manifest: resolveManifest(undefined, '/opt/coredoc-workflows'),
      digest: null,
      secrets: [],
    });
  });

  it('reads an MCP server header from the runner variable it names, and refuses the manifest when it is unset', async () => {
    const path = join(dir, 'tools.json');
    const workflow = {
      title: 'Digest',
      repositories: 'none',
      delivery: 'none',
      plugins: [{ path: '/opt/acme/digest' }],
      mcpServers: {
        slack: {
          url: 'https://tools.acme.example/mcp',
          headers: { Authorization: 'env:ACME_TOOLS_TOKEN', 'X-Team': 'ops' },
        },
      },
      phases: [{ id: 'digest', gate: 'none', entrySkill: 'digest:run' }],
    };
    await writeFile(path, JSON.stringify({ version: 2, workflows: { digest: workflow } }));

    const loaded = await loadManifest(
      { COREDOC_RUNNER_MANIFEST: path, ACME_TOOLS_TOKEN: 'Bearer s3cret-value' },
      '/opt/x',
    );
    expect(loaded.manifest.workflows[0]?.mcpServers.slack?.headers).toEqual({
      Authorization: 'Bearer s3cret-value',
      'X-Team': 'ops',
    });
    expect(loaded.secrets).toEqual(['Bearer s3cret-value']);

    await expect(loadManifest({ COREDOC_RUNNER_MANIFEST: path }, '/opt/x')).rejects.toThrow(/ACME_TOOLS_TOKEN/);
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
