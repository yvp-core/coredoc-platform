import { describe, expect, it } from 'vitest';
import { resolveManifest } from './manifest.js';

const DEFAULT_PLUGIN = '/opt/coredoc-workflows';

const defaultWorkflow = (overrides: Record<string, unknown> = {}) => ({
  id: 'default',
  title: 'Story to pull request',
  repositories: 'write',
  delivery: 'pull-request',
  plugins: [{ path: '/opt/coredoc-workflows' }],
  tools: { jira: [], google: [] },
  mcpServers: {},
  phases: [
    { id: 'scope', gate: 'acceptance' },
    { id: 'implement', gate: 'none' },
  ],
  ...overrides,
});

const review = {
  title: 'Document review',
  repositories: 'none',
  delivery: 'none',
  plugins: [{ path: '/opt/acme/plugins/review' }],
  tools: { google: ['read', 'write'] },
  phases: [
    { id: 'review', gate: 'acceptance', entrySkill: 'review:review' },
    { id: 'record', gate: 'none', entrySkill: 'review:record', model: 'claude-sonnet-5-5', effort: 'low' },
  ],
};

const v2 = (workflows: Record<string, unknown>) => JSON.stringify({ version: 2, workflows });

describe('resolveManifest', () => {
  it('without a manifest resolves to the default workflow', () => {
    expect(resolveManifest(undefined, DEFAULT_PLUGIN)).toEqual({ workflows: [defaultWorkflow()] });
  });

  it('resolves a version 1 manifest to the default workflow with its plugins, tools and phases', () => {
    const manifest = JSON.stringify({
      version: 1,
      plugins: [{ path: '/opt/acme/plugins/acme-agent-run' }],
      tools: { jira: ['read'] },
      phases: { scope: { model: 'claude-opus-5-5', effort: 'high', entrySkill: 'acme-agent-run:scope' } },
    });
    expect(resolveManifest(manifest, DEFAULT_PLUGIN)).toEqual({
      workflows: [
        defaultWorkflow({
          plugins: [{ path: '/opt/acme/plugins/acme-agent-run' }],
          tools: { jira: ['read'], google: [] },
          phases: [
            {
              id: 'scope',
              gate: 'acceptance',
              model: 'claude-opus-5-5',
              effort: 'high',
              entrySkill: 'acme-agent-run:scope',
            },
            { id: 'implement', gate: 'none' },
          ],
        }),
      ],
    });
  });

  it('resolves each version 2 workflow under its id', () => {
    expect(resolveManifest(v2({ 'doc-review': review }), DEFAULT_PLUGIN)).toEqual({
      workflows: [{ id: 'doc-review', ...review, tools: { jira: [], google: ['read', 'write'] }, mcpServers: {} }],
    });
  });

  it('keeps a workflow’s own MCP servers, and lets one take the name of a tool family the workflow does not grant', () => {
    const mcpServers = {
      slack: { url: 'https://tools.acme.example/mcp/slack', headers: { Authorization: 'env:ACME_TOOLS_TOKEN' } },
      google: { url: 'http://tools.acme.svc/mcp/google' },
    };
    const [workflow] = resolveManifest(v2({ x: { ...review, tools: {}, mcpServers } }), DEFAULT_PLUGIN).workflows;
    expect(workflow?.mcpServers).toEqual({
      slack: mcpServers.slack,
      google: { url: 'http://tools.acme.svc/mcp/google', headers: {} },
    });
  });

  it.each([
    ['not JSON', '{version: 1'],
    ['an unknown key', '{"version":1,"phase":{}}'],
    ['another version', '{"version":3}'],
    ['a relative plugin path', '{"version":1,"plugins":[{"path":"plugins/day"}]}'],
    ['no plugins', '{"version":1,"plugins":[]}'],
    ['an entry skill without its plugin', '{"version":1,"phases":{"scope":{"entrySkill":"scope"}}}'],
    ['an unknown phase', '{"version":1,"phases":{"delivery":{"model":"x"}}}'],
    ['an unsupported Jira access', '{"version":1,"tools":{"jira":["comment"]}}'],
    ['no workflows', v2({})],
    ['a gated last phase', v2({ x: { ...review, phases: [review.phases[0]] } })],
    ['an ungated phase before the last', v2({ x: { ...review, phases: [review.phases[1], review.phases[1]] } })],
    ['a repeated phase id', v2({ x: { ...review, phases: [review.phases[0], review.phases[0], review.phases[1]] } })],
    ['a phase named delivery', v2({ x: { ...review, phases: [{ ...review.phases[1], id: 'delivery' }] } })],
    ['a phase without an entry skill', v2({ x: { ...review, phases: [{ id: 'record', gate: 'none' }] } })],
    ['pull requests without repositories', v2({ x: { ...review, delivery: 'pull-request' } })],
    ['a workflow id with capitals', v2({ Review: review })],
    ['a write grant without read', v2({ x: { ...review, tools: { jira: ['write'] } } })],
    ['an unknown tool family', v2({ x: { ...review, tools: { slack: ['read'] } } })],
    [
      'an MCP server named like Coredoc’s',
      v2({ x: { ...review, mcpServers: { 'acme-coredoc': { url: 'https://a.example' } } } }),
    ],
    [
      'an MCP server under a granted tool family’s name',
      v2({ x: { ...review, mcpServers: { google: { url: 'https://a.example' } } } }),
    ],
    ['an MCP server that is not HTTP', v2({ x: { ...review, mcpServers: { slack: { url: 'file:///opt/slack' } } } })],
    [
      'an MCP server header the runner sets',
      v2({
        x: {
          ...review,
          mcpServers: { slack: { url: 'https://a.example', headers: { 'X-Coredoc-Run-Id': 'forged' } } },
        },
      }),
    ],
    ['an unknown effort', v2({ x: { ...review, phases: [{ ...review.phases[1], effort: 'extreme' }] } })],
  ])('rejects %s', (_case, text) => {
    expect(() => resolveManifest(text, DEFAULT_PLUGIN)).toThrow(/manifest/i);
  });
});
