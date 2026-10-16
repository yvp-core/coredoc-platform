/**
 * Task-trace gantt: one lane per evidence source, rendered from the pure
 * `layoutGantt` output. Every fill is a `--color-*` token; the stage ramp is
 * sequential pipeline progress (`--color-stage-1..5`, cycled), not a
 * categorical state family.
 */

import { useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { formatDurationMs } from '@coredoc/core/browser/format';
import { ChartTooltip, TOOLTIP_FLIP_THRESHOLD, TOOLTIP_HALF_WIDTH } from './ChartTooltip.js';
import {
  clampTooltipX,
  type GanttLane,
  type GanttMark,
  type GanttSegment,
  layoutGantt,
  tooltipPlacement,
} from '@coredoc/core/browser/chart-geometry';
import { useChartWidth } from './use-chart-width.js';

const STAGE_TOKENS = [
  'var(--color-stage-1)',
  'var(--color-stage-2)',
  'var(--color-stage-3)',
  'var(--color-stage-4)',
  'var(--color-stage-5)',
] as const;

const SURFACE = 'var(--color-surface)';
const PR_ACCENT = 'var(--color-violet-text)';
const PR_TRACK = 'var(--color-violet-wash)';
const BRAND = 'var(--color-brand)';
const REWORK = 'var(--color-rework)';
const FAILED = 'var(--color-danger)';

/** Tracker states are a categorical family; anything unmapped falls back to the neutral track. */
function trackerStateFill(state: string): string {
  if (state === 'Done') return BRAND;
  if (state === 'In Review') return 'var(--color-blue-wash)';
  if (state === 'In Progress') return 'var(--color-brand-wash)';
  return 'var(--color-track)';
}

function stageFill(stageIndex: number): string {
  return STAGE_TOKENS[stageIndex % STAGE_TOKENS.length] ?? STAGE_TOKENS[0];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Approximate advance width of the 10.5px lane label, used to keep it inside the gutter. */
const LABEL_CHAR_PX = 6;

function fitLaneLabel(label: string, gutter: number): string {
  const max = Math.max(4, Math.floor((gutter - 14) / LABEL_CHAR_PX));
  return label.length <= max ? label : `${label.slice(0, max - 1)}…`;
}

/** UTC formatting keeps the axis and tooltips deterministic across host locales. */
function dayLabel(ms: number): string {
  return new Date(ms).toISOString().slice(5, 10);
}

/** A sub-day trace is labelled by the hour, so its ticks are not five identical dates. */
function timeLabel(ms: number): string {
  return new Date(ms).toISOString().slice(11, 16);
}

function stampLabel(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

interface Tip {
  x: number;
  /** Anchor when the readout sits above (its bottom edge). */
  aboveY: number;
  /** Anchor when the readout is flipped below (its top edge) — past the element, not over it. */
  belowY: number;
  title: string;
  detail: string;
}

function segmentTip(segment: GanttSegment): Tip {
  if (segment.kind === 'tracker-state') {
    return {
      x: segment.x + segment.width / 2,
      aboveY: segment.y - 8,
      belowY: segment.y + segment.height + 8,
      title: segment.state,
      detail: `${stampLabel(segment.startMs)} · ${formatDurationMs(segment.endMs - segment.startMs)} in state`,
    };
  }
  if (segment.kind === 'run-span') {
    return {
      x: segment.x + segment.width / 2,
      aboveY: segment.y - 8,
      belowY: segment.y + segment.height + 8,
      title: segment.label,
      detail: `${formatDurationMs(segment.endMs - segment.startMs)} · ${segment.outcome ?? 'outcome unknown'}`,
    };
  }
  if (segment.kind === 'stage') {
    return {
      x: segment.x + segment.width / 2,
      aboveY: segment.y - 8,
      belowY: segment.y + segment.height + 8,
      title: `${segment.stageId} · attempt ${segment.attempt}`,
      detail: `${formatDurationMs(segment.endMs - segment.startMs)} · ${segment.outcome ?? '…'} · ${stampLabel(segment.startMs)}`,
    };
  }
  return {
    x: segment.x + segment.width / 2,
    aboveY: segment.y - 4,
    belowY: segment.y + segment.height + 4,
    title: 'pull request',
    detail: `${stampLabel(segment.startMs)} → ${stampLabel(segment.endMs)}`,
  };
}

function markTip(mark: GanttMark): Tip {
  return {
    x: mark.x,
    aboveY: mark.y - 12,
    belowY: mark.y + 12,
    title: mark.label,
    detail: stampLabel(mark.atMs),
  };
}

export function GanttChart({
  lanes,
  start,
  end,
  ariaLabel,
  gutter = 130,
  rowHeight = 30,
  axisHeight = 26,
  minWidth = 480,
  /** Headroom above the first lane equal to the readout height, so its hover readout always fits above. */
  padTop = TOOLTIP_FLIP_THRESHOLD,
  className,
}: {
  lanes: ReadonlyArray<GanttLane>;
  /** Window bounds in epoch ms; the caller owns the padding it wants around the facts. */
  start: number;
  end: number;
  ariaLabel: string;
  gutter?: number;
  rowHeight?: number;
  axisHeight?: number;
  minWidth?: number;
  padTop?: number;
  className?: string;
}) {
  const { ref, width } = useChartWidth(minWidth);
  const [tip, setTip] = useState<Tip | null>(null);
  const layout = useMemo(
    () => layoutGantt({ lanes, start, end, width, gutter, rowHeight, axisHeight, padTop }),
    [lanes, start, end, width, gutter, rowHeight, axisHeight, padTop],
  );
  // Below two days the day ticks would all print the same date (or none at all).
  const tickLabel = end - start < 2 * DAY_MS ? timeLabel : dayLabel;

  const tipPlacement = tooltipPlacement(tip?.aboveY ?? Number.NaN, TOOLTIP_FLIP_THRESHOLD);

  const hover = (next: Tip) => ({
    onPointerEnter: () => setTip(next),
    onPointerLeave: () => setTip(null),
  });

  return (
    <div ref={ref} className={cn('w-full overflow-x-auto', className)}>
      <div className="relative" style={{ width: layout.width }}>
        <svg
          role="img"
          aria-label={ariaLabel}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          width={layout.width}
          height={layout.height}
          className="block"
        >
          {layout.gridlines.map((gridline) => (
            <g key={gridline.ms}>
              <line
                x1={gridline.x}
                x2={gridline.x}
                y1={layout.plotTop}
                y2={layout.plotBottom}
                stroke="var(--color-grid)"
                strokeWidth={1}
              />
              {gridline.labelled ? (
                <text x={gridline.x} y={layout.height - 8} textAnchor="middle" fontSize={10} fill="var(--color-ink-4)">
                  {tickLabel(gridline.ms)}
                </text>
              ) : null}
            </g>
          ))}

          {layout.rows.map((row) => (
            <g key={`${row.index}-${row.label}`}>
              <line
                x1={0}
                x2={layout.width}
                y1={row.y + row.height}
                y2={row.y + row.height}
                stroke="var(--color-border-soft)"
                strokeWidth={1}
              />
              <text
                x={layout.gutter - 10}
                y={row.midY + 3.5}
                textAnchor="end"
                fontSize={10.5}
                fill="var(--color-ink-3)"
              >
                <title>{row.label}</title>
                {fitLaneLabel(row.label, layout.gutter)}
              </text>

              {row.segments.map((segment, index) => {
                const key = `${row.index}-seg-${index}`;
                if (segment.kind === 'tracker-state') {
                  return (
                    <rect
                      key={key}
                      x={segment.x}
                      y={segment.y}
                      width={segment.width}
                      height={segment.height}
                      rx={3}
                      fill={trackerStateFill(segment.state)}
                      {...hover(segmentTip(segment))}
                    />
                  );
                }
                if (segment.kind === 'run-span') {
                  return (
                    <rect
                      key={key}
                      x={segment.x}
                      y={segment.y}
                      width={segment.width}
                      height={segment.height}
                      rx={4}
                      fill="var(--color-track)"
                      {...hover(segmentTip(segment))}
                    />
                  );
                }
                if (segment.kind === 'stage') {
                  return (
                    <rect
                      key={key}
                      x={segment.x}
                      y={segment.y}
                      width={segment.width}
                      height={segment.height}
                      rx={3}
                      fill={stageFill(segment.stageIndex)}
                      {...hover(segmentTip(segment))}
                    />
                  );
                }
                return (
                  <rect
                    key={key}
                    x={segment.x}
                    y={segment.y}
                    width={segment.width}
                    height={segment.height}
                    rx={2}
                    fill={PR_TRACK}
                    {...hover(segmentTip(segment))}
                  />
                );
              })}

              {row.marks.map((mark, index) => {
                const key = `${row.index}-mark-${index}`;
                const tipProps = hover(markTip(mark));
                if (mark.kind === 'stage-failed') {
                  return (
                    <rect
                      key={key}
                      x={mark.x - 3}
                      y={mark.y - 3}
                      width={6}
                      height={6}
                      rx={1}
                      fill={FAILED}
                      stroke={SURFACE}
                      strokeWidth={1.5}
                      {...tipProps}
                    />
                  );
                }
                if (mark.kind === 'stage-reentry' || mark.kind === 'tracker-reopened') {
                  return (
                    <circle
                      key={key}
                      cx={mark.x}
                      cy={mark.y}
                      r={mark.kind === 'tracker-reopened' ? 5 : 4}
                      fill={REWORK}
                      stroke={SURFACE}
                      strokeWidth={1.5}
                      {...tipProps}
                    />
                  );
                }
                if (mark.kind === 'artifact-created' || mark.kind === 'artifact-updated') {
                  return (
                    <rect
                      key={key}
                      x={mark.x - 4}
                      y={mark.y - 4}
                      width={8}
                      height={8}
                      rx={1.5}
                      transform={`rotate(45 ${mark.x} ${mark.y})`}
                      fill={mark.kind === 'artifact-updated' ? 'var(--color-ink-3)' : SURFACE}
                      stroke="var(--color-ink-3)"
                      strokeWidth={1.5}
                      {...tipProps}
                    />
                  );
                }
                if (mark.kind === 'ship') {
                  return (
                    <g key={key} {...tipProps}>
                      <line
                        x1={mark.x}
                        x2={mark.x}
                        y1={layout.plotTop}
                        y2={layout.plotBottom}
                        stroke={BRAND}
                        strokeWidth={1}
                        opacity={0.35}
                      />
                      <path
                        d={`M${mark.x} ${mark.y - 7} l 9 3.5 l -9 3.5 Z`}
                        fill={BRAND}
                        stroke={SURFACE}
                        strokeWidth={1}
                      />
                    </g>
                  );
                }
                const merged = mark.kind === 'pr-merged';
                return (
                  <circle
                    key={key}
                    cx={mark.x}
                    cy={mark.y}
                    r={merged ? 5.5 : 4.5}
                    fill={merged ? PR_ACCENT : SURFACE}
                    stroke={merged ? SURFACE : PR_ACCENT}
                    strokeWidth={merged ? 2 : 1.5}
                    {...tipProps}
                  />
                );
              })}
            </g>
          ))}
        </svg>

        {tip ? (
          <ChartTooltip
            x={clampTooltipX(tip.x, layout.width, TOOLTIP_HALF_WIDTH)}
            y={tipPlacement === 'below' ? tip.belowY : tip.aboveY}
            placement={tipPlacement}
            visible
          >
            <div className="font-medium">{tip.title}</div>
            <div className="text-tooltip-ink/70">{tip.detail}</div>
          </ChartTooltip>
        ) : null}
      </div>
    </div>
  );
}
