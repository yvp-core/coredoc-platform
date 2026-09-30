/**
 * Pure-SVG trend sparkline for the KPI tiles. Hand-rolled (desktop ships no chart
 * library) and stretched to its container with preserveAspectRatio="none". It is
 * decorative single-series trend context — one hue, no axes, no legend (the tile
 * label names the series), per the dataviz form heuristic for a stat-tile spark.
 *
 * The point→path geometry is factored into `computeSparkline` so it can be unit
 * tested without a DOM.
 */

/** A single timeseries point mirrors ipc-types `TimeseriesPoint`. */
export interface SparklinePoint {
  date: string;
  value: number;
}

export interface SparklineGeometry {
  /** SVG path `d` for the trend stroke. */
  line: string;
  /** SVG path `d` for the filled area under the stroke. */
  area: string;
  /** End-point coordinates (for the terminal dot). */
  endX: number;
  endY: number;
  width: number;
  height: number;
}

const W = 240;
const H = 34;
const PAD = 2;

/**
 * Compute the sparkline geometry from raw values. Returns null when there are
 * fewer than two points (nothing to draw, and the x-step would divide by zero).
 * Flat series are handled without producing NaN/Infinity (range floored to 1).
 */
export function computeSparkline(values: number[], width = W, height = H, pad = PAD): SparklineGeometry | null {
  if (values.length < 2) return null;

  const mn = Math.min(...values);
  const mx = Math.max(...values);
  const range = mx - mn || 1;
  const pts = values.map((v, i) => {
    const x = pad + (i * (width - 2 * pad)) / (values.length - 1);
    const y = height - pad - ((v - mn) / range) * (height - 2 * pad);
    return [x, y] as const;
  });

  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const area = `${line} L${(width - pad).toFixed(1)} ${height} L${pad.toFixed(1)} ${height} Z`;
  // ?? fallback is unreachable (length >= 2 above) — satisfies indexed-access strictness.
  const [endX, endY] = pts[pts.length - 1] ?? [0, 0];

  return { line, area, endX, endY, width, height };
}

const SPARK_COLOR = 'var(--color-content-brand)';

export function Sparkline({
  points,
  color = SPARK_COLOR,
  className,
}: {
  points: SparklinePoint[];
  color?: string;
  className?: string;
}) {
  const geo = computeSparkline(points.map((p) => p.value));
  if (!geo) return null;

  return (
    <svg viewBox={`0 0 ${geo.width} ${geo.height}`} preserveAspectRatio="none" aria-hidden="true" className={className}>
      <path d={geo.area} fill={color} opacity={0.1} />
      <path d={geo.line} fill="none" stroke={color} strokeWidth={1.6} vectorEffect="non-scaling-stroke" />
      <circle cx={geo.endX.toFixed(1)} cy={geo.endY.toFixed(1)} r={2.4} fill={color} />
    </svg>
  );
}
