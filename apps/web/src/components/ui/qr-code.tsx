import { useMemo } from 'react';
import { encode } from 'uqr';

/** QR code drawn as one SVG path (no innerHTML); dark modules on a white quiet zone. */
export function QrCode({
  value,
  label,
  size = 192,
}: {
  value: string;
  label: string;
  size?: number;
}) {
  const { path, cells } = useMemo(() => {
    const { data, size: n } = encode(value, { border: 2 });
    const parts: string[] = [];
    data.forEach((row, y) =>
      row.forEach((dark, x) => {
        if (dark) parts.push(`M${x} ${y}h1v1h-1z`);
      }),
    );
    return { path: parts.join(''), cells: n };
  }, [value]);

  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${cells} ${cells}`}
      width={size}
      height={size}
      shapeRendering="crispEdges"
      className="rounded-md bg-white"
    >
      <path d={path} fill="#000" />
    </svg>
  );
}
