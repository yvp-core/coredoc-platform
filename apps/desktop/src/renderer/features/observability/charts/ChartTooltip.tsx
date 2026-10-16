/**
 * Chart hover readout. A positioned DOM node rather than an SVG label (ADR-5):
 * it inherits the app's tooltip recipe (`bg-bg-inverted-secondary`) and can wrap
 * text without manual measurement. The parent must be `relative`.
 *
 * `placement` exists because the enclosing Card is `overflow-hidden` and the chart
 * scroller is `overflow-x-auto` (which clips vertically as well): a readout above a
 * point near the plot top would be cut off, so the caller flips it below.
 */

import type { ReactNode } from 'react';
import { cn } from '../../../lib/utils';
import type { TooltipPlacement } from '@coredoc/core/browser/chart-geometry';

/** Half of the widest readout the charts render; used to clamp `x` inside the plot. */
export const TOOLTIP_HALF_WIDTH = 84;

/** Readout height plus its anchor offset — below this distance from the plot top it flips. */
export const TOOLTIP_FLIP_THRESHOLD = 56;

export function ChartTooltip({
  x,
  y,
  visible,
  placement = 'above',
  children,
  className,
}: {
  /** Anchor in container pixels; the tooltip is centred on `x`. */
  x: number;
  /** Anchor edge: the tooltip's bottom when `placement` is `above`, its top when `below`. */
  y: number;
  visible: boolean;
  placement?: TooltipPlacement;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        'pointer-events-none absolute z-10 -translate-x-1/2 rounded-lg bg-bg-inverted-secondary px-2 py-1.5 text-[11.5px] leading-4 text-content-inverted shadow-feature transition-opacity',
        placement === 'below' ? 'translate-y-0' : '-translate-y-full',
        visible ? 'opacity-100' : 'opacity-0',
        className,
      )}
      style={{ left: x, top: y }}
    >
      {children}
    </div>
  );
}
