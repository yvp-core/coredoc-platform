import { useCallback, useEffect, useState } from 'react';
import { useWorkspaceStore } from '../../stores/workspace-store';
import { CopilotSelect, CopyableCodeBlock, type CopilotTab } from '../McpConfigView';

const COPILOT_TO_TOOL: Record<CopilotTab, string> = {
  'claude-code': 'claude',
  cursor: 'cursor',
  claude: 'claude',
  chatgpt: 'claude',
};

interface TeamMcpConfigStepProps {
  workspaceId: string;
}

export function TeamMcpConfigStep({ workspaceId }: TeamMcpConfigStepProps) {
  const [copilot, setCopilot] = useState<CopilotTab>('claude-code');
  const [mcpConfigs, setMcpConfigs] = useState<Partial<Record<CopilotTab, string>>>({});
  const { getMcpConfig } = useWorkspaceStore();

  const loadMcpConfig = useCallback(
    async (tab: CopilotTab) => {
      if (mcpConfigs[tab]) return;
      const tool = COPILOT_TO_TOOL[tab];
      const config = await getMcpConfig(workspaceId, tool);
      const url = (config as { mcpServers?: { coredoc?: { url?: string } } }).mcpServers?.coredoc?.url ?? '';
      setMcpConfigs((prev) => ({
        ...prev,
        [tab]: tab === 'claude' || tab === 'chatgpt' ? url : JSON.stringify(config, null, 2),
      }));
    },
    [workspaceId, getMcpConfig, mcpConfigs],
  );

  useEffect(() => {
    loadMcpConfig(copilot);
  }, [copilot, loadMcpConfig]);

  return (
    // No wrapping card. The drawer's tab panel is already the surface and already
    // pads its content; a second border and a second 16px inset boxed the steps into
    // a card the design does not have. The chooser is a select, not a pill row —
    // there are four providers and the row could not show them all, which is why
    // ChatGPT was missing from it. The section label is a muted 12px caption rather
    // than a bold 14px heading, so the steps below it read as the content.
    <div className="flex flex-col gap-3">
      <CopilotSelect value={copilot} onChange={setCopilot} />

      <div className="flex flex-col gap-2">
        <p className="px-1 text-xs font-semibold leading-4 text-content-quaternary">
          {copilot === 'claude-code' && 'Add to your Claude Code MCP settings'}
          {copilot === 'cursor' && 'Add to your Cursor MCP settings'}
          {copilot === 'claude' && 'Web or Desktop'}
          {copilot === 'chatgpt' && 'Web only'}
        </p>

        <div className="px-1 flex flex-col text-xs space-y-1.5 text-content-tertiary">
          {copilot === 'claude-code' && (
            <>
              <p>1. In your project root, create .mcp.json</p>
              <p>2. Paste this JSON and save:</p>
            </>
          )}
          {copilot === 'cursor' && (
            <>
              <p>1. In Cursor, open Settings &rarr; MCP and open your MCP configuration file.</p>
              <p>2. Paste this JSON and save:</p>
            </>
          )}
          {copilot === 'claude' && (
            <>
              <p>1. Open Claude &rarr; Settings &rarr; Connectors</p>
              <p>2. Click "Add custom connector"</p>
              <p>3. Paste your MCP server URL:</p>
            </>
          )}
          {copilot === 'chatgpt' && (
            <>
              <p>1. Open ChatGPT &rarr; Settings &rarr; Apps and Connectors</p>
              <p>2. Scroll down &rarr; Advanced Settings &rarr; turn on Developer Mode</p>
              <p>3. Go back to Apps and Connectors &rarr; click "Create"</p>
              <p>4. Fill in Workspace Name & paste your MCP server URL:</p>
            </>
          )}
        </div>

        <div className="pt-1.5 pb-1">
          {mcpConfigs[copilot] ? (
            <CopyableCodeBlock code={mcpConfigs[copilot]!} />
          ) : (
            <div className="rounded-lg border border-border-tertiary bg-bg-overlay px-3 py-2 text-sm text-content-tertiary">
              Loading MCP configuration...
            </div>
          )}
        </div>

        <div className="px-1 text-xs text-content-tertiary space-y-1.5">
          {copilot === 'claude-code' && (
            <>
              <p>3. Restart Claude Code (or reload the project).</p>
              <p>4. Verify coredoc appears in the MCP server list.</p>
            </>
          )}
          {copilot === 'cursor' && (
            <>
              <p>3. Restart Cursor.</p>
              <p>4. Verify coredoc appears in the MCP server list.</p>
            </>
          )}
          {copilot === 'claude' && (
            <>
              <p>4. Click "Add"</p>
              <p>5. In any new chat: click "+" &rarr; Connectors &rarr; turn on CoreDoc</p>
            </>
          )}
          {copilot === 'chatgpt' && (
            <>
              <p>5. Check the trust box &rarr; click "Create"</p>
              <p>6. In any new chat: "+" &rarr; More &rarr; Developer Mode &rarr; Add sources &rarr; turn on CoreDoc</p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
