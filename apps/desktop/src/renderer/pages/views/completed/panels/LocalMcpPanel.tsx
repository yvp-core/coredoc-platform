import { useEffect, useState } from 'react';
import { InfoCircle, LinkCircle } from '@solar-icons/react';
import { Button } from '../../../../components/ui/button';
import { Alert, AlertTitle, AlertDescription, AlertActions } from '../../../../components/ui/alert';
import { McpConfigView } from '../../../../components/McpConfigView';
import type { McpInfoResult } from '../../../../../shared/ipc-types';

export interface LocalMcpPanelProps {
  /** Selects which project's graph database the generated config points at. */
  projectId: string;
  /** Opens the Team MCP flow from the upsell card. */
  onConnectTeamMcp: () => void;
}

/**
 * Docked "Local MCP Server" panel.
 *
 * The dialog it replaces fetched on the `open` prop flipping true; the panel is
 * conditionally mounted, so mount *is* that transition and a plain effect works.
 */
export function LocalMcpPanel({ projectId, onConnectTeamMcp }: LocalMcpPanelProps) {
  const [mcpInfo, setMcpInfo] = useState<McpInfoResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const info = await window.electronAPI.getMcpInfo(projectId);
      if (!cancelled) setMcpInfo(info);
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto pb-4">
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-1 px-5">
          <LinkCircle weight="Outline" className="size-4 shrink-0 text-content-primary" />
          <h2 className="text-sm font-black leading-5 text-content-primary">Local MCP Server</h2>
        </div>

        <div className="px-5 pt-1">
          <Alert variant="info" className="flex-col gap-2 border-dodger-blue-50 px-0 py-3 [&>svg]:hidden">
            <AlertTitle className="flex h-5 items-center gap-1 px-3 font-bold">
              <InfoCircle weight="Bold" className="size-4 shrink-0 text-content-primary" />
              Your graph is local
            </AlertTitle>
            <AlertDescription className="pl-8 pr-3 text-content-secondary">
              Connect Team MCP to sync it automatically from your <strong className="font-extrabold">CI/CD</strong> and{' '}
              <strong className="font-extrabold">share it with your team.</strong>
            </AlertDescription>
            <AlertActions className="pl-8 pr-3 pt-0">
              <Button
                size="sm"
                className="h-auto w-fit rounded-lg border-2 border-accent-gradient bg-bg-action-primary px-4 py-1.5 text-content-inverted shadow-none hover:bg-bg-action-primary"
                onClick={onConnectTeamMcp}
              >
                Connect Team MCP
              </Button>
            </AlertActions>
          </Alert>
        </div>
      </div>

      <div className="px-3 pt-3">
        <div className="h-px w-full rounded-full bg-border-input" />
      </div>

      <div className="px-5 pt-4">
        <McpConfigView mcpInfo={mcpInfo} />
      </div>
    </div>
  );
}
