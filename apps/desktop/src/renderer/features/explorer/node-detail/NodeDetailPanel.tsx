import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { VizNode } from '@coredoc/core';
import { graphNodeQueryOptions } from '../../../api/graph.js';
import { humanizeType, nodeColor } from '../../../lib/viz-style.js';
import { DetailSection, LoadingDetail } from '../../../components/detail-section.js';
import { Button } from '../../../components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../components/ui/select';
import type { GraphScope } from '../../../../shared/ipc-types.js';

const TRAVERSE_DEPTHS = [2, 3, 4, 5];

export interface NodeDetailPanelProps {
  scope: GraphScope;
  node: VizNode;
  onTraverse: (depth: number) => void;
}

/**
 * Docked node-detail panel: identity, classification badges, a depth traverse,
 * and the type-specific detail body.
 *
 * The prose sections (Summary / Purpose / Business Logic) are not new server
 * fields — DetailSection already renders them. They only exist on some node
 * kinds: `purpose` + `businessLogic` on functions, `purpose` on entrypoints,
 * `documentation` elsewhere. DetailSection omits what a kind does not carry
 * rather than inventing an empty heading.
 */
export function NodeDetailPanel({ scope, node, onTraverse }: NodeDetailPanelProps) {
  const [depth, setDepth] = useState(3);
  const { data, isLoading } = useQuery(graphNodeQueryOptions(scope, node.id));

  const visibility = data?.detail?.kind === 'function' ? data.detail.visibility : undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-1 px-5 py-1.5">
          <span
            aria-hidden
            className="size-3 shrink-0 rounded-full"
            style={{ backgroundColor: nodeColor(node.type) }}
          />
          <h2
            className="min-w-0 truncate font-mono text-sm font-black leading-5 text-content-primary"
            title={node.name}
          >
            {node.name}
          </h2>
        </div>

        {node.filePath && (
          <p
            className="truncate pr-4 pl-9 text-xs font-semibold leading-4 text-content-secondary"
            title={node.filePath}
          >
            {node.filePath}
            {node.startLine ? `:${node.startLine}` : ''}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2 px-5 pt-0.5">
          <Chip color={nodeColor(node.type)}>{humanizeType(node.type)}</Chip>
          {node.repoName && <Chip>{node.repoName}</Chip>}
          {visibility && <Chip>{visibility}</Chip>}
        </div>
      </div>

      <div className="px-3 pt-3">
        <div className="h-px rounded-[10px] bg-border-input" />
      </div>

      <div className="flex items-center gap-3 px-5 pt-2.5">
        <span className="text-xs font-semibold leading-4 text-content-secondary">Depth</span>
        <Select value={String(depth)} onValueChange={(v) => setDepth(Number(v))}>
          <SelectTrigger
            size="sm"
            className="gap-0.5 border-transparent bg-transparent px-0 text-xs leading-4 font-extrabold text-content-action-secondary shadow-none"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TRAVERSE_DEPTHS.map((d) => (
              <SelectItem key={d} value={String(d)}>
                {d}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button size="sm" className="ml-auto" onClick={() => onTraverse(depth)}>
          Traverse
        </Button>
      </div>

      <div className="px-3 pt-3">
        <div className="h-px rounded-[10px] bg-border-input" />
      </div>

      {node.summary && (
        <div className="flex flex-col gap-1 px-5 pt-3">
          <span className="text-xs font-medium leading-4 text-content-quaternary">Summary:</span>
          <p className="text-sm leading-5 text-content-secondary">{node.summary}</p>
        </div>
      )}

      {isLoading ? <LoadingDetail /> : data?.detail ? <DetailSection detail={data.detail} /> : null}

      <div className="h-4 shrink-0" />
    </div>
  );
}

/** Outlined tag: the node-type accent is per-type, so it stays an inline style. */
function Chip({ children, color }: { children: React.ReactNode; color?: string }) {
  if (!color) {
    return (
      <span className="rounded-md border border-gray-500 px-2 py-1 text-xs leading-4 font-semibold text-content-tag-initial">
        {children}
      </span>
    );
  }
  return (
    <span className="rounded-md border px-2 py-1 text-xs leading-4 font-semibold" style={{ borderColor: color, color }}>
      {children}
    </span>
  );
}
