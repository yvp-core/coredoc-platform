import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { mcpConfigQueryOptions } from '@/api/queries/mcp-config';
import type { McpConfig } from '@/api/types';
import { QueryBoundary } from '@/components/query-boundary';
import { Card, CardBody, CardHead } from '@/components/ui/card';
import { Segmented } from '@/components/ui/segmented';

import { CopyBlock } from './copy-block';

type Tool = 'claude' | 'cursor' | 'codex';

const TOOLS: { value: Tool; label: string }[] = [
  { value: 'claude', label: 'Claude Code' },
  { value: 'cursor', label: 'Cursor' },
  { value: 'codex', label: 'Codex' },
];

// The server returns one fixed entry regardless of client (it ignores the
// `?tool=` query the desktop app sends), so the per-tool shaping happens here.
const SNIPPETS: Record<Tool, { filename: string; hint: string; build: (url: string) => string }> = {
  claude: {
    filename: '.mcp.json',
    hint: 'Save this in the project root, then reconnect — Claude Code signs in through the browser, no token to paste.',
    build: (url) => JSON.stringify({ mcpServers: { coredoc: { type: 'http', url } } }, null, 2),
  },
  cursor: {
    filename: '~/.cursor/mcp.json',
    hint: 'Settings → MCP → open the config file, paste this, then restart Cursor.',
    build: (url) => JSON.stringify({ mcpServers: { coredoc: { type: 'http', url } } }, null, 2),
  },
  codex: {
    filename: '~/.codex/config.toml',
    hint: 'Append this block, then export COREDOC_TOKEN with a service token from the CI/CD tab — Codex is headless and cannot complete the browser sign-in.',
    build: (url) => `[mcp_servers.coredoc]\nurl = "${url}"\nbearer_token_env_var = "COREDOC_TOKEN"`,
  },
};

/**
 * The MCP url the server advertises. It comes from an env var with no
 * server-side validation, so an unusable value is treated as a missing one
 * rather than rendered into a config nobody can connect with.
 */
function mcpServerUrl(config: McpConfig): string | null {
  const url = config.mcpServers['coredoc']?.url;
  if (!url) return null;
  try {
    new URL(url);
    return url;
  } catch {
    return null;
  }
}

export function McpConfigPanel({ wsId }: { wsId: string }) {
  const [tool, setTool] = useState<Tool>('claude');
  const query = useQuery(mcpConfigQueryOptions(wsId));
  const snippet = SNIPPETS[tool];

  return (
    <Card>
      <CardHead
        title="MCP config"
        sub="Point an agent at this workspace's code graph"
        right={<Segmented<Tool> value={tool} onChange={setTool} items={TOOLS} />}
      />
      <CardBody className="flex flex-col gap-3">
        <QueryBoundary query={query}>
          {(config) => {
            const url = mcpServerUrl(config);
            if (!url) {
              return (
                <p className="text-[13px] text-danger-text">
                  This server did not return a usable MCP url — check MCP_SERVER_URL on the deployment.
                </p>
              );
            }
            return (
              <>
                <p className="text-[13px] text-ink-3">{snippet.hint}</p>
                <CopyBlock value={snippet.build(url)} label={`Copy ${snippet.filename}`} filename={snippet.filename} />
              </>
            );
          }}
        </QueryBoundary>
      </CardBody>
    </Card>
  );
}
