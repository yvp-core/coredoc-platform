import { useLayoutEffect, useRef, useState } from 'react';

export function useTabIndicator(activeTab: string) {
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState({ left: 0, width: 0 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const update = () => {
      const active = el.querySelector('[data-state="active"]') as HTMLElement | null;
      setStyle(active ? { left: active.offsetLeft, width: active.offsetWidth } : { left: 0, width: 0 });
    };

    update();

    const observer = new ResizeObserver(update);
    observer.observe(el);
    window.addEventListener('resize', update);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [activeTab]);

  return { ref, style };
}
