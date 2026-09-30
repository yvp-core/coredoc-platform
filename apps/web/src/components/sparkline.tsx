/**
 * Pure-SVG area sparkline for KPI tiles: brand stroke over a brand wash,
 * stretched by the parent via preserveAspectRatio="none".
 */

const W = 240;
const H = 34;
const PAD = 2;

export function Sparkline({ data, className }: { data: number[]; className?: string }) {
  // A line needs two points; fewer would divide by zero on the x-step below.
  if (data.length < 2) return null;

  const mn = Math.min(...data);
  const mx = Math.max(...data);
  const rg = mx - mn || 1;
  const pts = data.map(
    (v, i) => [PAD + (i * (W - 2 * PAD)) / (data.length - 1), H - PAD - ((v - mn) / rg) * (H - 2 * PAD)] as const,
  );
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const area = `${line} L${W - PAD} ${H} L${PAD} ${H} Z`;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true" className={className}>
      <path d={area} fill="var(--brand-wash)" />
      <path d={line} fill="none" stroke="var(--brand)" strokeWidth={1.6} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
