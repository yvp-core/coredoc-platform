/**
 * Container width for the hand-rolled SVG charts. The ResizeObserver callback is
 * rAF-coalesced so a drag resize schedules at most one layout per frame.
 */

import { type RefObject, useEffect, useRef, useState } from 'react';
import { chartWidth } from '@coredoc/core/browser/chart-geometry';

export function useChartWidth(minWidth: number): { ref: RefObject<HTMLDivElement>; width: number } {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(minWidth);

  useEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === 'undefined') return;

    let frame = 0;
    const measure = () => {
      frame = 0;
      // `getBoundingClientRect`, not `clientWidth`: clientWidth rounds a 900.5px box
      // up to 901, and a chart drawn one pixel wider than its own scroll container
      // paints a permanent horizontal scrollbar under every chart.
      setWidth(chartWidth(minWidth, node.getBoundingClientRect().width));
    };
    const observer = new ResizeObserver(() => {
      if (frame !== 0) return;
      frame = requestAnimationFrame(measure);
    });
    observer.observe(node);
    measure();

    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [minWidth]);

  return { ref, width };
}
