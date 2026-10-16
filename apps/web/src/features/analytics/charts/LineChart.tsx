/**
 * Daily timeseries: area + line + endpoint with a crosshair hover readout.
 * Hand-rolled SVG over the pure `layoutTimeseries` geometry; a `null` point is a
 * gap in the line, never a zero.
 */

import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { ChartTooltip, TOOLTIP_FLIP_THRESHOLD, TOOLTIP_HALF_WIDTH } from './ChartTooltip.js';
import { clampTooltipX, layoutTimeseries, nearestIndex, tooltipPlacement } from '@coredoc/core/browser/chart-geometry';
import { useChartWidth } from './use-chart-width.js';

export interface LineChartPoint {
  /** ISO date of the bucket (UTC day). */
  date: string;
  /** `null` = no data for that bucket; the line breaks rather than dropping to 0. */
  value: number | null;
}

const MARGINS = { top: 14, right: 14, bottom: 26, left: 46 };
const MIN_WIDTH = 560;
const X_LABEL_TARGET = 6;

function defaultXLabel(point: LineChartPoint): string {
  return point.date.length >= 10 ? point.date.slice(5, 10) : point.date;
}

export function LineChart({
  points,
  format,
  axisFormat,
  height = 240,
  renderTooltip,
  ariaLabel,
  xLabel = defaultXLabel,
  className,
}: {
  points: ReadonlyArray<LineChartPoint>;
  format: (value: number) => string;
  /** Y-axis tick formatter; defaults to `format`. */
  axisFormat?: (value: number) => string;
  height?: number;
  renderTooltip?: (point: LineChartPoint, index: number) => ReactNode;
  ariaLabel: string;
  xLabel?: (point: LineChartPoint) => string;
  className?: string;
}) {
  const { ref, width } = useChartWidth(MIN_WIDTH);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  // A new series invalidates the crosshair: without this the readout keeps the
  // old index and narrates the new points under the pointer.
  // biome-ignore lint/correctness/useExhaustiveDependencies: points is an intentional reset trigger, not a value read in the body
  useEffect(() => setHoverIndex(null), [points]);

  const values = useMemo(() => points.map((point) => point.value), [points]);
  const layout = useMemo(() => layoutTimeseries({ width, height, margins: MARGINS, values }), [width, height, values]);

  const formatAxis = axisFormat ?? format;
  const labelStep = Math.max(1, Math.round(points.length / X_LABEL_TARGET));
  const hovered = hoverIndex === null ? null : (layout.samples[hoverIndex] ?? null);
  const hoveredPoint = hoverIndex === null ? null : (points[hoverIndex] ?? null);
  // A gap has no dot to anchor to; the plot top stands in and flips the readout down.
  const anchorY = hovered?.y ?? layout.plot.top;
  const placement = tooltipPlacement(anchorY, TOOLTIP_FLIP_THRESHOLD);

  const onPointerMove = (event: React.PointerEvent<SVGRectElement>) => {
    const svg = svgRef.current;
    if (!svg || points.length === 0) return;
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0) return;
    const px = (event.clientX - rect.left) * (layout.width / rect.width);
    setHoverIndex(nearestIndex(px, layout.plot.left, layout.plot.width, points.length));
  };

  return (
    <div ref={ref} className={cn('w-full overflow-x-auto', className)}>
      <div className="relative" style={{ width: layout.width }}>
        <svg
          ref={svgRef}
          role="img"
          aria-label={ariaLabel}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          width={layout.width}
          height={layout.height}
          className="block"
        >
          {layout.ticks.map((tick) => (
            <g key={tick}>
              <line
                x1={layout.plot.left}
                x2={layout.plot.left + layout.plot.width}
                y1={layout.y(tick)}
                y2={layout.y(tick)}
                stroke={tick === 0 ? 'var(--color-axis)' : 'var(--color-grid)'}
                strokeWidth={1}
              />
              <text
                x={layout.plot.left - 8}
                y={layout.y(tick) + 3.5}
                textAnchor="end"
                fontSize={10.5}
                fill="var(--color-ink-4)"
                style={{ fontVariantNumeric: 'tabular-nums' }}
              >
                {formatAxis(tick)}
              </text>
            </g>
          ))}

          {points.map((point, index) =>
            index % labelStep === 0 ? (
              <text
                key={point.date}
                x={layout.x(index)}
                y={layout.height - 8}
                textAnchor="middle"
                fontSize={10.5}
                fill="var(--color-ink-4)"
              >
                {xLabel(point)}
              </text>
            ) : null,
          )}

          <path d={layout.area} fill="var(--color-brand)" opacity={0.1} />
          <path
            d={layout.line}
            fill="none"
            stroke="var(--color-brand)"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          {layout.endpoint ? (
            <circle
              cx={layout.endpoint.x}
              cy={layout.endpoint.y}
              r={4.5}
              fill="var(--color-brand)"
              stroke="var(--color-surface)"
              strokeWidth={2}
            />
          ) : null}

          {hovered ? (
            <line
              x1={hovered.x}
              x2={hovered.x}
              y1={layout.plot.top}
              y2={layout.plot.top + layout.plot.height}
              stroke="var(--color-axis)"
              strokeWidth={1}
            />
          ) : null}
          {hovered && hovered.y !== null ? (
            <circle
              cx={hovered.x}
              cy={hovered.y}
              r={4.5}
              fill="var(--color-brand)"
              stroke="var(--color-surface)"
              strokeWidth={2}
            />
          ) : null}

          <rect
            x={layout.plot.left}
            y={layout.plot.top}
            width={layout.plot.width}
            height={layout.plot.height}
            fill="transparent"
            onPointerMove={onPointerMove}
            onPointerLeave={() => setHoverIndex(null)}
          />
        </svg>

        {hovered && hoveredPoint ? (
          <ChartTooltip
            x={clampTooltipX(hovered.x, layout.width, TOOLTIP_HALF_WIDTH)}
            y={placement === 'below' ? anchorY + 12 : anchorY - 12}
            placement={placement}
            visible
          >
            {renderTooltip ? (
              renderTooltip(hoveredPoint, hovered.index)
            ) : (
              <>
                <div className="font-medium">
                  {hoveredPoint.value === null ? 'no data' : format(hoveredPoint.value)}
                </div>
                <div className="text-tooltip-ink/70">{hoveredPoint.date}</div>
              </>
            )}
          </ChartTooltip>
        ) : null}
      </div>
    </div>
  );
}
