import { describe, expect, it } from 'vitest';
import { resolveManifest } from './manifest.js';

const DEFAULT_PLUGIN = '/opt/coredoc-workflows';

describe('resolveManifest', () => {
  it('without a manifest reproduces the platform defaults', () => {
    expect(resolveManifest(undefined, DEFAULT_PLUGIN)).toEqual({
      plugins: [{ path: '/opt/coredoc-workflows' }],
      tools: { jira: [] },
      phases: { scope: {}, implement: {} },
    });
  });

  it('overrides plugins and tools, and merges each phase over the defaults', () => {
    const manifest = JSON.stringify({
      version: 1,
      plugins: [{ path: '/opt/coredoc-workflows' }, { path: '/opt/acme/plugins/acme-agent-run' }],
      tools: { jira: ['read'] },
      phases: { scope: { model: 'claude-opus-5-5', entrySkill: 'acme-agent-run:scope' } },
    });
    expect(resolveManifest(manifest, DEFAULT_PLUGIN)).toEqual({
      plugins: [{ path: '/opt/coredoc-workflows' }, { path: '/opt/acme/plugins/acme-agent-run' }],
      tools: { jira: ['read'] },
      phases: { scope: { model: 'claude-opus-5-5', entrySkill: 'acme-agent-run:scope' }, implement: {} },
    });
  });

  it('keeps the default plugin when the manifest only sets a phase', () => {
    expect(
      resolveManifest('{"version":1,"phases":{"implement":{"model":"claude-sonnet-5-5"}}}', DEFAULT_PLUGIN),
    ).toEqual({
      plugins: [{ path: '/opt/coredoc-workflows' }],
      tools: { jira: [] },
      phases: { scope: {}, implement: { model: 'claude-sonnet-5-5' } },
    });
  });

  it.each([
    ['not JSON', '{version: 1'],
    ['an unknown key', '{"version":1,"phase":{}}'],
    ['another version', '{"version":2}'],
    ['a relative plugin path', '{"version":1,"plugins":[{"path":"plugins/day"}]}'],
    ['no plugins', '{"version":1,"plugins":[]}'],
    ['an entry skill without its plugin', '{"version":1,"phases":{"scope":{"entrySkill":"scope"}}}'],
    ['an unknown phase', '{"version":1,"phases":{"delivery":{"model":"x"}}}'],
    ['an unsupported Jira access', '{"version":1,"tools":{"jira":["comment"]}}'],
  ])('rejects %s', (_case, text) => {
    expect(() => resolveManifest(text, DEFAULT_PLUGIN)).toThrow(/manifest/i);
  });
});
