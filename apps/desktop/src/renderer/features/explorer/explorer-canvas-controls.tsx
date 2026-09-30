import { Maximize, TrashBinTrash } from '@solar-icons/react';
import { Button } from '../../components/ui/button';
import { useExplorer } from './explorer-context.js';

/**
 * Floating canvas controls, bottom-LEFT over the graph: the docked right panel
 * overlays the canvas, so bottom-right controls would be unreachable whenever a
 * panel is open.
 *
 * Deliberately only two verbs. Node-type and repo filtering belong to the left
 * panel's chips, and the display switches that used to hide behind a gear here
 * (isolated nodes, CONTAINS edges, per-edge-type visibility) were removed with
 * it — a second, invisible filter layer competing with the chips made the canvas
 * hard to reason about.
 */
export function ExplorerCanvasControls() {
  const { dispatch, canvasRef } = useExplorer();

  return (
    <div className="pointer-events-auto absolute bottom-3 left-3 z-10 flex items-center gap-1.5">
      <Button
        variant="outline"
        size="icon-lg"
        aria-label="Fit graph to view"
        title="Fit to view"
        className="rounded-full border-zinc-100 shadow-action"
        onClick={() => canvasRef.current?.fitView()}
      >
        <Maximize className="size-4" />
      </Button>

      <Button
        variant="outline"
        size="icon-lg"
        aria-label="Clear graph"
        title="Clear graph"
        className="rounded-full border-zinc-100 text-content-warning shadow-action"
        onClick={() => dispatch({ kind: 'clear' })}
      >
        <TrashBinTrash className="size-4" />
      </Button>
    </div>
  );
}
