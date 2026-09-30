import { ExplorerCanvas } from '../../../../features/explorer/explorer-canvas.js';
import { ExplorerCanvasControls } from '../../../../features/explorer/explorer-canvas-controls.js';
import { useExplorer } from '../../../../features/explorer/explorer-context.js';
import { canvasBannerMessage, canvasIsFull } from '../../../../features/explorer/explorer-graph.js';
import { useTheme } from '../../../../lib/explorer-theme.js';

export interface GraphTabProps {
  /** Fired when the canvas selects a node — the shell opens the detail panel. */
  onNodeSelected: () => void;
  /** Fired on background click — the shell closes it again. */
  onNodeDeselected: () => void;
}

/** The Graph tab body: the graph canvas and its empty/filtered states. */
export function GraphTab({ onNodeSelected, onNodeDeselected }: GraphTabProps) {
  const {
    state,
    visible,
    canvasRef,
    selectNode,
    deselect,
    expandAll,
    edgesTruncated,
    linkingUnavailable,
    linkFetchFailed,
  } = useExplorer();
  const theme = useTheme();
  const banner = canvasBannerMessage({
    isFull: canvasIsFull(state),
    linkingUnavailable,
    linkFetchFailed,
    edgesTruncated,
  });

  if (state.nodes.size === 0) {
    return (
      <div className="flex flex-1 items-center justify-center rounded-xl px-6 text-center">
        <p className="rounded-xl border border-border-secondary bg-bg-primary px-5 py-4 text-sm text-content-secondary shadow-foundation">
          Search for a symbol, browse a type, or run a query to seed the graph.
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl">
      {/* The dot ground lives on the row above (CompletedView) so it runs under the
          filter panel too — this stays a plain transparent canvas host. */}
      <div className="relative min-h-0 flex-1">
        <ExplorerCanvas
          ref={canvasRef}
          nodes={visible.nodes}
          edges={visible.edges}
          selectedId={state.selectedId}
          theme={theme}
          onNodeClick={(id) => {
            selectNode(id);
            onNodeSelected();
          }}
          onNodeDoubleClick={(id) => void expandAll(id)}
          onCanvasClick={() => {
            deselect();
            onNodeDeselected();
          }}
        />
        <ExplorerCanvasControls />
        {/* Which degraded state to name (and their precedence) lives in
            canvasBannerMessage — see explorer-graph.ts. */}
        {banner && visible.nodes.length > 0 ? (
          <div className="pointer-events-none absolute inset-x-0 top-2 flex justify-center">
            <p className="rounded-full border border-content-tag-warning bg-bg-tag-warning px-3 py-1 text-xs text-content-primary">
              {banner}
            </p>
          </div>
        ) : null}
        {visible.nodes.length === 0 ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <p className="rounded-full border border-border-secondary bg-bg-primary px-3 py-1.5 text-xs text-content-secondary shadow-foundation">
              All nodes hidden by filters — adjust the chips in the side panel.
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
