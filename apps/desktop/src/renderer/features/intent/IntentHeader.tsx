/**
 * The intent surface's header: who this knowledge base belongs to
 * and which of its surfaces the reader is on. Every member may review (BR-1).
 * The Review count is the same waiting number the top-bar discovery badge
 * shows, so the two can never disagree.
 */

import { Notebook } from '@solar-icons/react';
import { Badge } from '../../components/ui/badge';
import { Tabs, TabsList, TabsTrigger } from '../../components/ui/tabs';
import { IntentPanelTab } from './intent-panel-state';

export interface IntentHeaderProps {
  /** The workspace slug when the caller knows it, else its id — shown in mono. */
  workspaceLabel: string;
  tab: IntentPanelTab;
  /** Waiting candidates; zero renders no badge, exactly like the top bar. */
  pendingCount: number;
  onTabChange: (tab: IntentPanelTab) => void;
}

export function IntentHeader({ workspaceLabel, tab, pendingCount, onTabChange }: IntentHeaderProps) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-3 px-1 pb-3">
      <div className="flex flex-col gap-1">
        <span className="text-[11px] font-medium uppercase tracking-[0.02em] text-content-tertiary">Coredoc Cloud</span>
        <div className="flex flex-wrap items-center gap-2">
          <Notebook weight="Bold" className="size-4 text-content-brand" />
          <h2 className="text-[17px] font-semibold leading-6 text-content-primary">Product intent</h2>
          <span className="font-mono text-[11px] text-content-quaternary">{workspaceLabel}</span>
        </div>
      </div>

      <Tabs value={tab} onValueChange={(value) => onTabChange(value as IntentPanelTab)}>
        <TabsList variant="pill">
          <TabsTrigger value={IntentPanelTab.Browse}>Browse</TabsTrigger>
          <TabsTrigger value={IntentPanelTab.Releases}>Delivery history</TabsTrigger>
          <TabsTrigger value={IntentPanelTab.Review}>
            Review
            {pendingCount > 0 && <Badge variant="info">{pendingCount}</Badge>}
          </TabsTrigger>
        </TabsList>
      </Tabs>
    </header>
  );
}
