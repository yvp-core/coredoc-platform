import { ReactNode, useRef } from 'react';
import { TransformWrapper, TransformComponent, useControls } from 'react-zoom-pan-pinch';
import { ZoomIn, ZoomOut, RotateCcw } from 'lucide-react';
import { Button } from '../ui/button';

interface DiagramContainerProps {
  children: ReactNode;
  maxHeight?: number;
  className?: string;
}

function ZoomControls() {
  const { zoomIn, zoomOut, resetTransform } = useControls();

  return (
    <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity z-10">
      <Button variant="secondary" size="icon" className="h-7 w-7" onClick={() => zoomIn()} title="Zoom in">
        <ZoomIn className="h-3.5 w-3.5" />
      </Button>
      <Button variant="secondary" size="icon" className="h-7 w-7" onClick={() => zoomOut()} title="Zoom out">
        <ZoomOut className="h-3.5 w-3.5" />
      </Button>
      <Button variant="secondary" size="icon" className="h-7 w-7" onClick={() => resetTransform()} title="Reset">
        <RotateCcw className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

export function DiagramContainer({ children, maxHeight = 500, className }: DiagramContainerProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  return (
    <div
      ref={containerRef}
      className={`relative group rounded-lg border bg-muted/30 overflow-hidden ${className || ''}`}
      style={{ maxHeight }}
    >
      <TransformWrapper
        initialScale={1}
        minScale={0.5}
        maxScale={4}
        wheel={{ step: 0.1 }}
        panning={{ velocityDisabled: true }}
        centerOnInit
      >
        <ZoomControls />
        <TransformComponent
          wrapperStyle={{
            width: '100%',
            height: '100%',
            maxHeight,
          }}
          contentStyle={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: '200px',
            padding: '1rem',
          }}
        >
          {children}
        </TransformComponent>
      </TransformWrapper>

      {/* Hint text */}
      <div className="absolute bottom-2 left-2 text-xs text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity">
        Scroll to zoom - Drag to pan
      </div>
    </div>
  );
}
