import { useRef, type PointerEvent, type RefObject } from 'react';
import { Button } from './button.tsx';

/**
 * A signature drawn with a finger, pen or mouse on a canvas; the caller reads it as a PNG
 * (`canvas.current.toBlob`). Check-in (M3-08) and POS room charges (M8-03) use it.
 */
export function SignaturePad({
  canvas,
  onSigned,
  label,
  clearLabel,
}: {
  canvas: RefObject<HTMLCanvasElement | null>;
  onSigned: (signed: boolean) => void;
  label: string;
  clearLabel: string;
}) {
  const drawing = useRef(false);
  const point = (e: PointerEvent<HTMLCanvasElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    return [
      ((e.clientX - box.left) * e.currentTarget.width) / box.width,
      ((e.clientY - box.top) * e.currentTarget.height) / box.height,
    ] as const;
  };
  return (
    <div className="mt-2">
      <canvas
        ref={canvas}
        width={600}
        height={160}
        aria-label={label}
        className="w-full max-w-xl touch-none rounded-md border border-border bg-white"
        onPointerDown={(e) => {
          const ctx = e.currentTarget.getContext('2d');
          if (!ctx) return;
          drawing.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          ctx.lineWidth = 2.5;
          ctx.lineCap = 'round';
          ctx.strokeStyle = '#111';
          ctx.beginPath();
          ctx.moveTo(...point(e));
        }}
        onPointerMove={(e) => {
          if (!drawing.current) return;
          const ctx = e.currentTarget.getContext('2d');
          ctx?.lineTo(...point(e));
          ctx?.stroke();
          onSigned(true);
        }}
        onPointerUp={() => {
          drawing.current = false;
        }}
      />
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          const c = canvas.current;
          c?.getContext('2d')?.clearRect(0, 0, c.width, c.height);
          onSigned(false);
        }}
      >
        {clearLabel}
      </Button>
    </div>
  );
}
