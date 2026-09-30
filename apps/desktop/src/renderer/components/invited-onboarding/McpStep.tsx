import { TeamMcpConfigStep } from '../team-mcp/TeamMcpConfigStep';

interface McpStepProps {
  workspaceId: string;
}

export function McpStep({ workspaceId }: McpStepProps) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-content-tertiary">Add this MCP server to your AI client.</p>
      <TeamMcpConfigStep workspaceId={workspaceId} />
    </div>
  );
}
