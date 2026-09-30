/**
 * Empty state for projects with no cloud workspace. Insights are a cloud feature
 * (per-user session + MCP metrics are aggregated server-side), so a local-only
 * project sees a short pitch that points at the project's *existing* cloud-sync
 * flow — this does not build or trigger a sync itself.
 */

import { ChartSquare } from '@solar-icons/react';
import { Card } from '../../components/ui/card';

export function ObservabilityUpsell() {
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <Card className="max-w-md items-center gap-3 px-6 py-7 text-center">
        <div className="flex size-11 items-center justify-center rounded-full bg-bg-tertiary text-content-brand">
          <ChartSquare weight="Bold" className="size-5" />
        </div>
        <h3 className="text-sm font-semibold text-content-primary">Insights live in the cloud</h3>
        <p className="text-xs leading-5 text-content-secondary">
          Connect this project to a cloud workspace to see team MCP usage, agent-session activity, spend, and Claude
          Code telemetry — aggregated across everyone on the workspace.
        </p>
        <p className="text-[11.5px] leading-5 text-content-quaternary">
          Use the <span className="font-medium text-content-secondary">Team MCP</span> / cloud-sync action on this
          project to get started.
        </p>
      </Card>
    </div>
  );
}
