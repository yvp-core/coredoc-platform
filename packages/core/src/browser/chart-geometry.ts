/**
 * Pure chart geometry for the Analytics surface (ADR-5: hand-rolled SVG, no chart
 * library). Nothing here touches React, the DOM, or the clock — every input is
 * explicit so the layouts are deterministic and unit-testable (AC-8).
 *
 * Colors are not decided here: layouts emit plain data (rects, marks, ticks) and
 * the thin SVG components map them onto `--color-*` tokens (BR-13).
 */

export interface ChartMargins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface ChartPoint {
  x: number;
  y: number;
}

/** Path coordinates are rounded so a layout re-run produces byte-identical `d` strings. */
function fmt(value: number): string {
  return value.toFixed(2);
}

/** Trims accumulated float error from repeated tick addition (0.30000000000000004). */
function trim(value: number): number {
  return Number(value.toPrecision(12));
}

/**
 * Axis ticks from 0 to at least `max`, stepped on a 1/2/5×10^n ladder.
 * `[0, 1]` for an empty or non-positive series so a flat/zero chart still draws
 * an axis instead of dividing by zero.
 */
export function niceTicks(max: number, count: number): number[] {
  if (!Number.isFinite(max) || max <= 0) return [0, 1];
  const steps = Math.max(1, Math.floor(count));
  const rough = max / steps;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalized = rough / magnitude;
  const step = (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10) * magnitude;
  const ticks: number[] = [];
  const last = Math.ceil(trim(max / step));
  for (let i = 0; i <= last; i += 1) ticks.push(trim(i * step));
  return ticks;
}

/** Maps a value from `domain` onto `range`; a zero-width domain pins to the range start. */
export function linearScale(
  domain: readonly [number, number],
  range: readonly [number, number],
): (v: number) => number {
  const span = domain[1] - domain[0];
  if (span === 0) return () => range[0];
  return (value) => range[0] + ((value - domain[0]) / span) * (range[1] - range[0]);
}

/** Polyline through the points; a `null` breaks the line and starts a new subpath (BR-17 gaps). */
export function linePath(points: ReadonlyArray<ChartPoint | null>): string {
  const parts: string[] = [];
  let penDown = false;
  for (const point of points) {
    if (point === null) {
      penDown = false;
      continue;
    }
    parts.push(`${penDown ? 'L' : 'M'}${fmt(point.x)} ${fmt(point.y)}`);
    penDown = true;
  }
  return parts.join(' ');
}

/** Filled area under the line; each contiguous run closes back to `baselineY` on its own. */
export function areaPath(points: ReadonlyArray<ChartPoint | null>, baselineY: number): string {
  const parts: string[] = [];
  let run: ChartPoint[] = [];
  const flush = () => {
    if (run.length === 0) return;
    const first = run[0]!;
    const last = run[run.length - 1]!;
    const body = run.map((p) => `L${fmt(p.x)} ${fmt(p.y)}`).join(' ');
    parts.push(`M${fmt(first.x)} ${fmt(baselineY)} ${body} L${fmt(last.x)} ${fmt(baselineY)} Z`);
    run = [];
  };
  for (const point of points) {
    if (point === null) flush();
    else run.push(point);
  }
  flush();
  return parts.join(' ');
}

/**
 * Index of the sample nearest to a pointer x, clamped to the series. `px` is in
 * the same coordinate space as `plotLeft`/`plotWidth` (SVG viewBox units).
 */
export function nearestIndex(px: number, plotLeft: number, plotWidth: number, count: number): number {
  if (count <= 1 || plotWidth <= 0) return 0;
  const ratio = (px - plotLeft) / plotWidth;
  const index = Math.round(ratio * (count - 1));
  return Math.min(count - 1, Math.max(0, index));
}

export type TooltipPlacement = 'above' | 'below';

/**
 * Which side of the anchor a hover readout may occupy. The chart card clips
 * (`overflow-hidden` on the Card, `overflow-x-auto` on the scroller, which clips
 * vertically too), so a readout drawn above an anchor with less than `threshold`
 * pixels of container above it is simply invisible: flip it below instead.
 * `anchorY` is measured from the container top, so any headroom the chart
 * reserves above its plot counts as room for the readout.
 */
export function tooltipPlacement(anchorY: number, threshold: number): TooltipPlacement {
  if (!Number.isFinite(anchorY)) return 'above';
  return anchorY < threshold ? 'below' : 'above';
}

/**
 * Horizontal anchor for a readout centred on `x`, kept inside the drawing width so
 * the first and last buckets do not push it under the clip. When the readout is
 * wider than the chart there is no satisfying position, so it is centred.
 */
export function clampTooltipX(x: number, width: number, halfWidth: number): number {
  if (!Number.isFinite(width) || !Number.isFinite(halfWidth) || width <= 0) return x;
  if (width <= halfWidth * 2) return width / 2;
  return Math.min(width - halfWidth, Math.max(halfWidth, x));
}

export interface TimeseriesLayoutInput {
  width: number;
  height: number;
  margins: ChartMargins;
  /** One value per bucket, oldest first; `null` is "no data", never zero (BR-17). */
  values: ReadonlyArray<number | null>;
  tickCount?: number;
}

export interface TimeseriesSample {
  index: number;
  value: number | null;
  x: number;
  y: number | null;
}

export interface TimeseriesLayout {
  width: number;
  height: number;
  plot: { left: number; top: number; width: number; height: number };
  ticks: number[];
  yMax: number;
  x: (index: number) => number;
  y: (value: number) => number;
  samples: TimeseriesSample[];
  line: string;
  area: string;
  /** Last sample carrying a value — the terminal dot/label anchor; null for an all-null series. */
  endpoint: { index: number; value: number; x: number; y: number } | null;
}

export function layoutTimeseries(input: TimeseriesLayoutInput): TimeseriesLayout {
  const { width, height, margins, values } = input;
  const plot = {
    left: margins.left,
    top: margins.top,
    width: Math.max(0, width - margins.left - margins.right),
    height: Math.max(0, height - margins.top - margins.bottom),
  };
  const present = values.filter((v): v is number => v !== null && Number.isFinite(v));
  const ticks = niceTicks(present.length > 0 ? Math.max(...present) : 0, input.tickCount ?? 4);
  const yMax = ticks[ticks.length - 1] ?? 1;

  const lastIndex = Math.max(1, values.length - 1);
  const x = (index: number) => plot.left + (values.length <= 1 ? 0 : (index / lastIndex) * plot.width);
  const y = linearScale([0, yMax], [plot.top + plot.height, plot.top]);

  const samples: TimeseriesSample[] = values.map((value, index) => ({
    index,
    value,
    x: x(index),
    y: value === null || !Number.isFinite(value) ? null : y(value),
  }));
  const points = samples.map((s) => (s.y === null ? null : { x: s.x, y: s.y }));

  let endpoint: TimeseriesLayout['endpoint'] = null;
  for (let i = samples.length - 1; i >= 0; i -= 1) {
    const sample = samples[i]!;
    if (sample.value !== null && sample.y !== null) {
      endpoint = { index: sample.index, value: sample.value, x: sample.x, y: sample.y };
      break;
    }
  }

  return {
    width,
    height,
    plot,
    ticks,
    yMax,
    x,
    y,
    samples,
    line: linePath(points),
    area: areaPath(points, plot.top + plot.height),
    endpoint,
  };
}

/**
 * Drawing width for a chart inside its scroll container: the measured width when
 * the container can hold the chart, `minWidth` (and a horizontal scrollbar) only
 * when it genuinely cannot. `measuredWidth` is the container's fractional width;
 * flooring it keeps a 900.5px box from being drawn 901px wide, which would paint
 * a permanent scrollbar under a chart that fits.
 */
export function chartWidth(minWidth: number, measuredWidth: number): number {
  if (!Number.isFinite(measuredWidth) || measuredWidth <= 0) return minWidth;
  return Math.max(minWidth, Math.floor(measuredWidth));
}

/** Percentage width for a magnitude bar; `minPct` keeps a non-zero value visible. */
export function magnitudeWidth(value: number, max: number, minPct = 0): number {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0 || value <= 0) return 0;
  return Math.min(100, Math.max(minPct, (value / max) * 100));
}

/* ---------------------------------------------------------------------------
 * Gantt (task trace, UC-4)
 * ------------------------------------------------------------------------- */

export interface GanttTrackerState {
  /** State entered at `at`; `from` is the previous state, used to mark reopens. */
  state: string;
  from: string | null;
  at: number;
}

export interface GanttRunStage {
  stageId: string;
  start: number;
  end: number;
  attempt: number;
  outcome: string | null;
}

export type GanttLane =
  | { kind: 'tracker'; label: string; states: ReadonlyArray<GanttTrackerState> }
  | {
      kind: 'run';
      label: string;
      start: number;
      end: number;
      outcome: string | null;
      stages: ReadonlyArray<GanttRunStage>;
    }
  | {
      kind: 'pr';
      label: string;
      opened: number;
      ready: number | null;
      firstReview: number | null;
      approved: number | null;
      merged: number | null;
    }
  | { kind: 'artifact'; label: string; createdAt: number; updatedAt: number | null; revisionCount: number }
  | { kind: 'ship'; label: string; at: number };

export type GanttSegment =
  | {
      kind: 'tracker-state';
      x: number;
      width: number;
      y: number;
      height: number;
      state: string;
      startMs: number;
      endMs: number;
    }
  | {
      kind: 'run-span';
      x: number;
      width: number;
      y: number;
      height: number;
      label: string;
      outcome: string | null;
      startMs: number;
      endMs: number;
    }
  | {
      kind: 'stage';
      x: number;
      width: number;
      y: number;
      height: number;
      stageId: string;
      /** Position in `GanttLayout.stageOrder` (first-seen); the chart cycles the token ramp. */
      stageIndex: number;
      attempt: number;
      outcome: string | null;
      startMs: number;
      endMs: number;
    }
  | { kind: 'pr-span'; x: number; width: number; y: number; height: number; startMs: number; endMs: number };

export type GanttMarkKind =
  | 'tracker-reopened'
  | 'stage-reentry'
  | 'stage-failed'
  | 'pr-opened'
  | 'pr-ready'
  | 'pr-first-review'
  | 'pr-approved'
  | 'pr-merged'
  | 'artifact-created'
  | 'artifact-updated'
  | 'ship';

export interface GanttMark {
  kind: GanttMarkKind;
  x: number;
  y: number;
  atMs: number;
  label: string;
}

export interface GanttRow {
  index: number;
  laneKind: GanttLane['kind'];
  label: string;
  y: number;
  height: number;
  midY: number;
  segments: GanttSegment[];
  marks: GanttMark[];
}

export interface GanttGridline {
  ms: number;
  x: number;
  labelled: boolean;
}

export interface GanttLayoutInput {
  lanes: ReadonlyArray<GanttLane>;
  start: number;
  end: number;
  width: number;
  gutter: number;
  rowHeight: number;
  axisHeight: number;
  padTop?: number;
  padRight?: number;
}

export interface GanttLayout {
  width: number;
  height: number;
  gutter: number;
  plotTop: number;
  plotBottom: number;
  x: (ms: number) => number;
  rows: GanttRow[];
  gridlines: GanttGridline[];
  /** Stage ids in first-seen order (lane order, then stage start) — the color key. */
  stageOrder: string[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Interval count for the sub-day axis fallback (5 labelled ticks). */
const SUBDAY_TICKS = 4;

/** Stable sort by timestamp: equal timestamps keep their input order. */
function byTime<T>(items: ReadonlyArray<T>, at: (item: T) => number): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => at(a.item) - at(b.item) || a.index - b.index)
    .map((entry) => entry.item);
}

export function layoutGantt(input: GanttLayoutInput): GanttLayout {
  const { lanes, start, end, width, gutter, rowHeight, axisHeight } = input;
  const padTop = input.padTop ?? 8;
  const padRight = input.padRight ?? 20;
  const innerWidth = Math.max(1, width - gutter - padRight);
  const span = Math.max(1, end - start);
  const x = (ms: number) => gutter + ((ms - start) / span) * innerWidth;

  const plotTop = padTop;
  const plotBottom = padTop + lanes.length * rowHeight;
  const height = plotBottom + axisHeight;

  const stageOrder: string[] = [];
  const stageIndexOf = (stageId: string): number => {
    const existing = stageOrder.indexOf(stageId);
    if (existing >= 0) return existing;
    stageOrder.push(stageId);
    return stageOrder.length - 1;
  };

  const rows: GanttRow[] = lanes.map((lane, index) => {
    const y = padTop + index * rowHeight;
    const midY = y + rowHeight / 2;
    const barY = midY - 7;
    const barH = 14;
    const segments: GanttSegment[] = [];
    const marks: GanttMark[] = [];

    if (lane.kind === 'tracker') {
      const states = byTime(lane.states, (s) => s.at);
      states.forEach((state, i) => {
        const until = states[i + 1]?.at ?? end;
        segments.push({
          kind: 'tracker-state',
          x: x(state.at),
          width: Math.max(2, x(until) - x(state.at) - 2),
          y: barY + 3,
          height: 8,
          state: state.state,
          startMs: state.at,
          endMs: until,
        });
        if (state.from === 'Done') {
          marks.push({ kind: 'tracker-reopened', x: x(state.at), y: midY, atMs: state.at, label: 'tracker_reopened' });
        }
      });
    }

    if (lane.kind === 'run') {
      segments.push({
        kind: 'run-span',
        x: x(lane.start),
        width: Math.max(3, x(lane.end) - x(lane.start)),
        y: barY,
        height: barH,
        label: lane.label,
        outcome: lane.outcome,
        startMs: lane.start,
        endMs: lane.end,
      });
      for (const stage of byTime(lane.stages, (s) => s.start)) {
        segments.push({
          kind: 'stage',
          x: x(stage.start) + 1,
          width: Math.max(3, x(stage.end) - x(stage.start) - 2),
          y: barY + 2,
          height: barH - 4,
          stageId: stage.stageId,
          stageIndex: stageIndexOf(stage.stageId),
          attempt: stage.attempt,
          outcome: stage.outcome,
          startMs: stage.start,
          endMs: stage.end,
        });
        if (stage.attempt > 1) {
          marks.push({
            kind: 'stage-reentry',
            x: x(stage.start) + 1,
            y: barY,
            atMs: stage.start,
            label: `${stage.stageId} re-entry · attempt ${stage.attempt}`,
          });
        }
        if (stage.outcome === 'failed') {
          marks.push({ kind: 'stage-failed', x: x(stage.end), y: barY, atMs: stage.end, label: stage.stageId });
        }
      }
    }

    if (lane.kind === 'pr') {
      const prEnd = lane.merged ?? end;
      segments.push({
        kind: 'pr-span',
        x: x(lane.opened),
        width: Math.max(3, x(prEnd) - x(lane.opened)),
        y: midY - 2,
        height: 4,
        startMs: lane.opened,
        endMs: prEnd,
      });
      const prMarks: Array<[GanttMarkKind, number | null, string]> = [
        ['pr-opened', lane.opened, 'opened'],
        ['pr-ready', lane.ready, 'ready for review'],
        ['pr-first-review', lane.firstReview, 'first review'],
        ['pr-approved', lane.approved, 'approved'],
        ['pr-merged', lane.merged, 'merged'],
      ];
      for (const [kind, at, label] of prMarks) {
        if (at === null) continue;
        marks.push({ kind, x: x(at), y: midY, atMs: at, label });
      }
    }

    if (lane.kind === 'artifact') {
      marks.push({
        kind: 'artifact-created',
        x: x(lane.createdAt),
        y: midY,
        atMs: lane.createdAt,
        label: 'created',
      });
      if (lane.updatedAt !== null) {
        marks.push({
          kind: 'artifact-updated',
          x: x(lane.updatedAt),
          y: midY,
          atMs: lane.updatedAt,
          label: `last updated · ${lane.revisionCount} revisions`,
        });
      }
    }

    if (lane.kind === 'ship') {
      marks.push({ kind: 'ship', x: x(lane.at), y: midY, atMs: lane.at, label: 'ship' });
    }

    return { index, laneKind: lane.kind, label: lane.label, y, height: rowHeight, midY, segments, marks };
  });

  const gridlines: GanttGridline[] = [];
  const firstDay = Math.ceil(start / DAY_MS) * DAY_MS;
  const dayCount = end >= firstDay ? Math.floor((end - firstDay) / DAY_MS) + 1 : 0;
  if (dayCount >= 2) {
    const labelEvery = Math.max(1, Math.ceil(dayCount / 9));
    for (let i = 0; i < dayCount; i += 1) {
      const ms = firstDay + i * DAY_MS;
      gridlines.push({ ms, x: x(ms), labelled: i % labelEvery === 0 });
    }
  } else {
    // A window shorter than two UTC-day boundaries crosses none, or one: day ticks
    // would leave the chart with no time axis at all. Fall back to even ticks across
    // the window so every trace states its own time scale.
    for (let i = 0; i <= SUBDAY_TICKS; i += 1) {
      const ms = start + (span * i) / SUBDAY_TICKS;
      gridlines.push({ ms, x: x(ms), labelled: true });
    }
  }

  return { width, height, gutter, plotTop, plotBottom, x, rows, gridlines, stageOrder };
}
