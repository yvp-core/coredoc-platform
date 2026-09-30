import {
  Chart2,
  ChatLine,
  CodeFile,
  LinkCircle,
  Notebook,
  ShareCircle,
  UserPlus,
  WindowFrame,
} from '@solar-icons/react';
import type { ReactNode } from 'react';
import { Badge } from '../../../components/ui/badge';
import { Button } from '../../../components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '../../../components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../components/ui/tooltip';
import { ProjectNameEditor } from '../../../components/ProjectNameEditor';
import { cn } from '../../../lib/utils';

/** The top-level surfaces of a completed workspace. */
export enum CompletedTab {
  Graph = 'graph',
  Chat = 'chat',
  Intent = 'intent',
  Analytics = 'analytics',
}

export interface CompletedTopBarProps {
  projectName: string;
  isCloudMember: boolean;
  activeTab: CompletedTab;
  onTabChange: (tab: CompletedTab) => void;
  onRenameProject: (name: string) => Promise<void>;
  /** Left-panel toggle. Disabled rather than hidden on tabs with no panel, so the row does not jump. */
  leftPanelOpen: boolean;
  leftPanelAvailable: boolean;
  onToggleLeftPanel: () => void;
  onOpenWorkspaceGraph: () => void;
  /** Owner-only: cloud members have no local MCP server to configure. */
  onOpenLocalMcp?: () => void;
  onConnectTeamMcp: () => void;
  /** Owners who have never synced see "Connect Team MCP"; everyone else "Team MCP". */
  teamMcpConnected: boolean;
  /** Team MCP is only reachable once the local graph is complete. */
  teamMcpAvailable: boolean;
  /**
   * Analytics is gated per workspace (`deliveryEnabled`) while the surface is
   * unstable, pre-redesign, and has no connector UI. False disables the tab
   * with a "Coming soon" tooltip.
   */
  analyticsAvailable: boolean;
  /**
   * The intent knowledge base is workspace-scoped (spec §11): the tree, its
   * reviewed items and their history all live in the cloud workspace, so a
   * local-only project has nothing to show and the tab is hidden rather than
   * disabled — unlike Analytics, this is an absent surface, not a gated one.
   */
  intentAvailable: boolean;
  /**
   * Intent candidates waiting for a decision (issue v1.1-01). Rendered on the
   * Intent tab so a maintainer learns about them WITHOUT opening the tab —
   * which is the whole point, since nothing else on this screen says so.
   *
   * Zero reads as no badge, and the owner passes zero for anyone who cannot
   * review: a count a member can do nothing about is noise. The gate here is a
   * UI affordance; the server refuses the decision regardless.
   */
  intentPendingCount?: number;
}

export function CompletedTopBar({
  projectName,
  isCloudMember,
  activeTab,
  onTabChange,
  onRenameProject,
  leftPanelOpen,
  leftPanelAvailable,
  onToggleLeftPanel,
  onOpenWorkspaceGraph,
  onOpenLocalMcp,
  onConnectTeamMcp,
  teamMcpConnected,
  teamMcpAvailable,
  analyticsAvailable,
  intentAvailable,
  intentPendingCount = 0,
}: CompletedTopBarProps) {
  return (
    <div className="flex shrink-0 items-center gap-3 px-4 py-1.5">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <IconButton
          label={leftPanelOpen ? 'Hide side panel' : 'Show side panel'}
          disabled={!leftPanelAvailable}
          onClick={onToggleLeftPanel}
        >
          <WindowFrame className="size-4" />
        </IconButton>

        {isCloudMember ? (
          <>
            <h1 className="truncate text-base font-bold leading-6 text-content-primary" title={projectName}>
              {projectName}
            </h1>
            <Badge variant="outlineInfo" className="shrink-0 py-0.5 text-[10px]">
              Invited
            </Badge>
          </>
        ) : (
          <ProjectNameEditor initialName={projectName} onSave={onRenameProject} />
        )}
      </div>

      <Tabs value={activeTab} onValueChange={(v) => onTabChange(v as CompletedTab)} className="shrink-0">
        <TabsList variant="pill">
          <TabsTrigger value={CompletedTab.Graph}>
            <ShareCircle className="size-4" />
            Graph
          </TabsTrigger>
          <TabsTrigger value={CompletedTab.Chat}>
            <ChatLine className="size-4" />
            Chat
          </TabsTrigger>
          {intentAvailable && (
            <TabsTrigger value={CompletedTab.Intent}>
              <Notebook className="size-4" />
              Intent
              {intentPendingCount > 0 && (
                <Badge variant="info" aria-label={`${intentPendingCount} intent candidates waiting for review`}>
                  {intentPendingCount}
                </Badge>
              )}
            </TabsTrigger>
          )}
          {analyticsAvailable ? (
            <TabsTrigger value={CompletedTab.Analytics}>
              <Chart2 className="size-4" />
              Analytics
            </TabsTrigger>
          ) : (
            <Tooltip>
              {/* The disabled trigger has pointer-events-none, so the tooltip
                  listens on this wrapper instead. */}
              <TooltipTrigger asChild>
                <span className="inline-flex">
                  <TabsTrigger value={CompletedTab.Analytics} disabled>
                    <Chart2 className="size-4" />
                    Analytics
                  </TabsTrigger>
                </span>
              </TooltipTrigger>
              <TooltipContent
                side="bottom"
                className="bg-bg-inverted-secondary text-white border-0 shadow-none rounded-md px-1 py-0.5 text-xs font-normal leading-4"
              >
                Coming soon
              </TooltipContent>
            </Tooltip>
          )}
        </TabsList>
      </Tabs>

      <div className="flex min-w-0 flex-1 items-center justify-end gap-3">
        <div className="flex items-center gap-1.5">
          <IconButton label="Workspace graph" onClick={onOpenWorkspaceGraph}>
            <CodeFile className="size-4" />
          </IconButton>
          {/* One link-circle, two owners. Once team MCP exists it owns this slot for
              everybody (owner and invited alike) and the CTA below is gone; before that
              it is the owner's local MCP server. The design carries exactly two circles
              here, so these are alternatives and never both. */}
          {teamMcpConnected ? (
            <IconButton label="Team MCP server" onClick={onConnectTeamMcp}>
              <LinkCircle className="size-4" />
            </IconButton>
          ) : (
            onOpenLocalMcp && (
              <IconButton label="Local MCP server" onClick={onOpenLocalMcp}>
                <LinkCircle className="size-4" />
              </IconButton>
            )
          )}
        </div>

        {teamMcpAvailable && !teamMcpConnected && (
          <Button
            variant="outline"
            size="sm"
            className="no-drag h-8 gap-1.5 border-2 border-accent-gradient px-4 text-xs font-semibold leading-4 text-content-primary shadow-action"
            onClick={onConnectTeamMcp}
          >
            <UserPlus className="size-4" />
            Connect Team MCP
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * The toolbar's "Button Circle": 32px white disc, zinc-100 hairline, 16px glyph.
 *
 * There is deliberately NO selected state. The design ships one recipe for this
 * button (`Button Circle`, Figma `4841:18548`) and the toggle it drives is already
 * legible from the panel it opens or closes; a second fill only made the same
 * control read as two different controls.
 */
function IconButton({
  children,
  label,
  onClick,
  disabled,
}: {
  children: ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'no-drag flex size-8 cursor-pointer items-center justify-center rounded-full border border-zinc-100 p-2 shadow-action transition-colors disabled:cursor-default disabled:opacity-40',
        'bg-bg-primary enabled:hover:bg-bg-primary-hover',
      )}
    >
      {children}
    </button>
  );
}
