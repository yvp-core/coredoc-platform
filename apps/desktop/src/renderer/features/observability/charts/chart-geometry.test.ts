import { describe, expect, it } from 'vitest';
import {
  areaPath,
  chartWidth,
  clampTooltipX,
  type GanttLane,
  layoutGantt,
  layoutTimeseries,
  linePath,
  linearScale,
  magnitudeWidth,
  nearestIndex,
  niceTicks,
  tooltipPlacement,
} from './chart-geometry';

const MARGINS = { top: 14, right: 14, bottom: 26, left: 46 };

describe('niceTicks', () => {
  it('steps on the 1/2/5 ladder and always starts at zero', () => {
    expect(niceTicks(10, 4)).toEqual([0, 5, 10]);
    expect(niceTicks(37, 4)).toEqual([0, 10, 20, 30, 40]);
    expect(niceTicks(0.9, 4)).toEqual([0, 0.5, 1]);
  });

  it('falls back to a unit axis for an empty or non-positive series', () => {
    expect(niceTicks(0, 4)).toEqual([0, 1]);
    expect(niceTicks(-5, 4)).toEqual([0, 1]);
    expect(niceTicks(Number.NaN, 4)).toEqual([0, 1]);
  });
});

describe('linearScale', () => {
  it('maps the domain onto the range', () => {
    const scale = linearScale([0, 10], [100, 0]);
    expect(scale(0)).toBe(100);
    expect(scale(10)).toBe(0);
    expect(scale(5)).toBe(50);
  });

  it('pins a zero-width domain to the range start instead of dividing by zero', () => {
    const scale = linearScale([4, 4], [100, 0]);
    expect(scale(4)).toBe(100);
    expect(scale(9)).toBe(100);
  });
});

describe('linePath / areaPath', () => {
  it('breaks the line and the area at a null point', () => {
    const points = [{ x: 0, y: 10 }, { x: 10, y: 20 }, null, { x: 30, y: 5 }, { x: 40, y: 7 }];
    expect(linePath(points)).toBe('M0.00 10.00 L10.00 20.00 M30.00 5.00 L40.00 7.00');
    expect(areaPath(points, 100)).toBe(
      'M0.00 100.00 L0.00 10.00 L10.00 20.00 L10.00 100.00 Z M30.00 100.00 L30.00 5.00 L40.00 7.00 L40.00 100.00 Z',
    );
  });

  it('emits nothing for an all-null series', () => {
    expect(linePath([null, null])).toBe('');
    expect(areaPath([null, null], 10)).toBe('');
  });
});

describe('nearestIndex', () => {
  it('clamps to the series bounds', () => {
    expect(nearestIndex(-500, 46, 400, 30)).toBe(0);
    expect(nearestIndex(5000, 46, 400, 30)).toBe(29);
  });

  it('rounds to the closest sample', () => {
    // 30 samples over 400px => ~13.79px per step; 46 + 3.5 steps rounds up to 4.
    expect(nearestIndex(46 + 400 * (3.5 / 29), 46, 400, 30)).toBe(4);
    expect(nearestIndex(46 + 400 * (3.4 / 29), 46, 400, 30)).toBe(3);
  });

  it('collapses to the single sample when there is nothing to choose between', () => {
    expect(nearestIndex(999, 46, 400, 1)).toBe(0);
    expect(nearestIndex(999, 46, 0, 30)).toBe(0);
  });
});

describe('layoutTimeseries', () => {
  it('keeps a flat series finite and anchors the endpoint on the last value', () => {
    const layout = layoutTimeseries({ width: 600, height: 240, margins: MARGINS, values: [5, 5, 5] });
    expect(layout.line).not.toMatch(/NaN|Infinity/);
    expect(layout.area).not.toMatch(/NaN|Infinity/);
    expect(layout.ticks).toEqual([0, 2, 4, 6]);
    expect(layout.yMax).toBe(6);
    expect(layout.endpoint).toEqual({ index: 2, value: 5, x: 586, y: layout.y(5) });
  });

  it('renders a null day as a gap and never as zero (BR-17)', () => {
    const layout = layoutTimeseries({ width: 600, height: 240, margins: MARGINS, values: [2, null, 4] });
    expect(layout.samples.map((s) => s.y === null)).toEqual([false, true, false]);
    expect(layout.line.match(/M/g)).toHaveLength(2);
    expect(layout.endpoint?.value).toBe(4);
  });

  it('has no endpoint and a unit axis when every value is null', () => {
    const layout = layoutTimeseries({ width: 600, height: 240, margins: MARGINS, values: [null, null] });
    expect(layout.endpoint).toBeNull();
    expect(layout.ticks).toEqual([0, 1]);
    expect(layout.line).toBe('');
  });
});

describe('chartWidth', () => {
  it('draws at the container width when the container is narrower than the gantt default', () => {
    // The trace card is ~615px wide in a 1149px window: at the old 640px floor the
    // chart was drawn wider than its own scroll container and painted a scrollbar.
    expect(chartWidth(480, 615)).toBe(615);
  });

  it('floors a fractional container so the chart never exceeds its scroll container by a pixel', () => {
    expect(chartWidth(480, 900.5)).toBe(900);
  });

  it('falls back to the minimum for a container narrower than the minimum or not yet measured', () => {
    expect(chartWidth(480, 320)).toBe(480);
    expect(chartWidth(480, 0)).toBe(480);
    expect(chartWidth(480, Number.NaN)).toBe(480);
  });
});

describe('magnitudeWidth', () => {
  it('floors a non-zero value at minPct and caps at 100', () => {
    expect(magnitudeWidth(1, 1000, 1.5)).toBe(1.5);
    expect(magnitudeWidth(500, 1000, 1.5)).toBe(50);
    expect(magnitudeWidth(2000, 1000, 1.5)).toBe(100);
  });

  it('renders nothing for zero, a zero max or a non-finite input', () => {
    expect(magnitudeWidth(0, 1000, 1.5)).toBe(0);
    expect(magnitudeWidth(5, 0, 1.5)).toBe(0);
    expect(magnitudeWidth(Number.NaN, 10, 1.5)).toBe(0);
  });
});

/**
 * AC-8 fixture: tracker states, two runs (one with a re-entry, one with a failed
 * stage), a PR with all five marks, an artifact with created/updated marks, and
 * ship evidence — with timestamps deliberately interleaved across lanes, so a
 * per-lane concatenation of x positions would not come out ordered by time.
 */
const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 7, 3, 9, 0, 0); // 2026-08-03T09:00Z

const TRACE_LANES: GanttLane[] = [
  {
    kind: 'tracker',
    label: 'ENG-42',
    states: [
      { state: 'To Do', from: null, at: T0 },
      { state: 'Done', from: 'In Review', at: T0 + 4 * DAY },
      { state: 'In Progress', from: null, at: T0 + 1 * DAY },
      { state: 'In Progress', from: 'Done', at: T0 + 5 * DAY },
    ],
  },
  {
    kind: 'run',
    label: 'implement run',
    start: T0 + 1 * DAY,
    end: T0 + 2 * DAY,
    outcome: 'completed',
    stages: [
      { stageId: 'plan', start: T0 + 1 * DAY, end: T0 + 1 * DAY + 3600_000, attempt: 1, outcome: 'ok' },
      { stageId: 'edit', start: T0 + 1 * DAY + 3600_000, end: T0 + 2 * DAY, attempt: 2, outcome: 'ok' },
    ],
  },
  {
    kind: 'run',
    label: 'verify run',
    start: T0 + 3 * DAY,
    end: T0 + 3 * DAY + 7200_000,
    outcome: 'failed',
    stages: [{ stageId: 'verify', start: T0 + 3 * DAY, end: T0 + 3 * DAY + 7200_000, attempt: 1, outcome: 'failed' }],
  },
  {
    kind: 'pr',
    label: 'PR #7',
    opened: T0 + 2 * DAY,
    ready: T0 + 2 * DAY + 3600_000,
    firstReview: T0 + 3 * DAY,
    approved: T0 + 3 * DAY + 3600_000,
    merged: T0 + 4 * DAY,
  },
  {
    kind: 'artifact',
    label: 'spec artifact',
    createdAt: T0 + 12 * 3600_000,
    updatedAt: T0 + 3 * DAY,
    revisionCount: 4,
  },
  { kind: 'ship', label: 'ship', at: T0 + 4 * DAY },
];

describe('layoutGantt', () => {
  const layout = layoutGantt({
    lanes: TRACE_LANES,
    start: T0,
    end: T0 + 6 * DAY,
    width: 900,
    gutter: 130,
    rowHeight: 30,
    axisHeight: 26,
  });

  it('lays out one row per lane and sizes the canvas from them', () => {
    expect(layout.rows.map((row) => [row.laneKind, row.label, row.y])).toEqual([
      ['tracker', 'ENG-42', 8],
      ['run', 'implement run', 38],
      ['run', 'verify run', 68],
      ['pr', 'PR #7', 98],
      ['artifact', 'spec artifact', 128],
      ['ship', 'ship', 158],
    ]);
    expect(layout.plotTop).toBe(8);
    expect(layout.plotBottom).toBe(188);
    expect(layout.height).toBe(214);
  });

  it('orders x by time across every lane, not per lane', () => {
    const events = layout.rows
      .flatMap((row) => [
        ...row.segments.map((segment) => ({ at: segment.startMs, x: segment.x })),
        ...row.marks.map((mark) => ({ at: mark.atMs, x: mark.x })),
      ])
      .sort((a, b) => a.at - b.at);

    // Every drawn item is anchored on its own timestamp (±1px of render inset),
    // so sorting by time sorts by x. A per-lane concatenation sawtooths here.
    for (const event of events) {
      expect(Math.abs(event.x - layout.x(event.at))).toBeLessThanOrEqual(1);
    }
    for (let i = 1; i < events.length; i += 1) {
      expect(events[i]!.x).toBeGreaterThanOrEqual(events[i - 1]!.x - 1);
    }
    // Guard the guard: the fixture really does interleave lanes.
    const laneOfEvent = layout.rows.flatMap((row) =>
      [...row.segments.map((s) => s.startMs), ...row.marks.map((m) => m.atMs)].map((at) => ({ at, lane: row.index })),
    );
    const lanesInTimeOrder = laneOfEvent.sort((a, b) => a.at - b.at).map((entry) => entry.lane);
    expect(new Set(lanesInTimeOrder.slice(0, 6)).size).toBeGreaterThan(1);
  });

  it('sorts tracker states by time and marks the reopen', () => {
    const tracker = layout.rows[0]!;
    expect(tracker.segments.map((segment) => (segment.kind === 'tracker-state' ? segment.state : null))).toEqual([
      'To Do',
      'In Progress',
      'Done',
      'In Progress',
    ]);
    expect(tracker.marks.map((mark) => [mark.kind, mark.atMs])).toEqual([['tracker-reopened', T0 + 5 * DAY]]);
  });

  it('assigns stage colors by first-seen order and marks re-entry and failure', () => {
    expect(layout.stageOrder).toEqual(['plan', 'edit', 'verify']);
    const firstRun = layout.rows[1]!;
    expect(
      firstRun.segments.map((segment) =>
        segment.kind === 'stage' ? [segment.stageId, segment.stageIndex, segment.attempt] : segment.kind,
      ),
    ).toEqual(['run-span', ['plan', 0, 1], ['edit', 1, 2]]);
    expect(firstRun.marks.map((mark) => mark.kind)).toEqual(['stage-reentry']);
    expect(layout.rows[2]!.marks.map((mark) => mark.kind)).toEqual(['stage-failed']);
  });

  it('emits all five PR marks, both artifact marks and the ship flag', () => {
    expect(layout.rows[3]!.marks.map((mark) => mark.kind)).toEqual([
      'pr-opened',
      'pr-ready',
      'pr-first-review',
      'pr-approved',
      'pr-merged',
    ]);
    expect(layout.rows[4]!.marks.map((mark) => mark.kind)).toEqual(['artifact-created', 'artifact-updated']);
    expect(layout.rows[5]!.marks.map((mark) => [mark.kind, mark.atMs])).toEqual([['ship', T0 + 4 * DAY]]);
  });

  it('places a day gridline per UTC midnight with a bounded label cadence', () => {
    expect(layout.gridlines.map((gridline) => gridline.labelled)).toEqual([true, true, true, true, true, true]);
    expect(layout.gridlines.map((gridline) => new Date(gridline.ms).toISOString().slice(0, 10))).toEqual([
      '2026-08-04',
      '2026-08-05',
      '2026-08-06',
      '2026-08-07',
      '2026-08-08',
      '2026-08-09',
    ]);
  });

  it('falls back to even ticks when the window crosses fewer than two UTC midnights', () => {
    const start = T0 + 15 * 60 * 60 * 1000;
    const end = start + 3 * 60 * 60 * 1000;
    const subDay = layoutGantt({
      lanes: TRACE_LANES,
      start,
      end,
      width: 900,
      gutter: 130,
      rowHeight: 30,
      axisHeight: 26,
    });

    // A three-hour trace crosses no midnight: day ticks would leave it with no axis.
    expect(subDay.gridlines).toHaveLength(5);
    expect(subDay.gridlines.every((gridline) => gridline.labelled)).toBe(true);
    expect(subDay.gridlines.map((gridline) => gridline.ms)).toEqual([
      start,
      start + 45 * 60 * 1000,
      start + 90 * 60 * 1000,
      start + 135 * 60 * 1000,
      end,
    ]);
  });

  it('is deterministic: the same input yields an identical layout', () => {
    const again = layoutGantt({
      lanes: TRACE_LANES,
      start: T0,
      end: T0 + 6 * DAY,
      width: 900,
      gutter: 130,
      rowHeight: 30,
      axisHeight: 26,
    });
    expect(again.rows).toEqual(layout.rows);
    expect(again.gridlines).toEqual(layout.gridlines);
    expect(again.stageOrder).toEqual(layout.stageOrder);
  });
});

describe('tooltipPlacement', () => {
  it('flips below when the anchor has less than the threshold of container above it', () => {
    expect(tooltipPlacement(0, 56)).toBe('below');
    expect(tooltipPlacement(20, 56)).toBe('below');
    expect(tooltipPlacement(55, 56)).toBe('below');
  });

  it('stays above once the headroom above the anchor covers the readout', () => {
    expect(tooltipPlacement(56, 56)).toBe('above');
    expect(tooltipPlacement(200, 56)).toBe('above');
  });

  it('treats a non-finite anchor as above so a broken sample cannot flip the readout', () => {
    expect(tooltipPlacement(Number.NaN, 56)).toBe('above');
  });
});

describe('clampTooltipX', () => {
  it('keeps a centred tooltip inside the drawing width', () => {
    expect(clampTooltipX(2, 900, 70)).toBe(70);
    expect(clampTooltipX(880, 900, 70)).toBe(830);
    expect(clampTooltipX(400, 900, 70)).toBe(400);
  });

  it('centres when the tooltip is wider than the chart rather than inverting the bounds', () => {
    expect(clampTooltipX(10, 100, 70)).toBe(50);
  });

  it('falls back to the anchor for a non-finite width', () => {
    expect(clampTooltipX(120, Number.NaN, 70)).toBe(120);
  });
});
