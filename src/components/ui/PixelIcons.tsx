/**
 * Pixel icons drawn as 8x8 SVG rect grids, lifted from the HackMIT mockups.
 * shapeRendering="crispEdges" keeps them hard-edged at any size.
 */

export function CoinIcon({ size = 24 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 8 8"
      width={size}
      height={size}
      shapeRendering="crispEdges"
      aria-hidden="true"
    >
      <rect x="2" y="0" width="4" height="1" fill="#F2B84B" />
      <rect x="1" y="1" width="6" height="1" fill="#F2B84B" />
      <rect x="0" y="2" width="8" height="4" fill="#F2B84B" />
      <rect x="1" y="6" width="6" height="1" fill="#F2B84B" />
      <rect x="2" y="7" width="4" height="1" fill="#F2B84B" />
      <rect x="3" y="2" width="2" height="4" fill="#B07A1B" />
      <rect x="2" y="3" width="4" height="1" fill="#B07A1B" />
      <rect x="2" y="5" width="4" height="1" fill="#B07A1B" />
    </svg>
  );
}

export function LockIcon({
  size = 14,
  color = "#7A5A3A",
  keyhole = "#FFF9EC",
  label,
}: {
  size?: number;
  color?: string;
  keyhole?: string;
  label?: string;
}) {
  return (
    <svg
      viewBox="0 0 8 8"
      width={size}
      height={size}
      shapeRendering="crispEdges"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : "true"}
    >
      <rect x="2" y="0" width="4" height="1" fill={color} />
      <rect x="1" y="1" width="1" height="3" fill={color} />
      <rect x="6" y="1" width="1" height="3" fill={color} />
      <rect x="0" y="4" width="8" height="4" fill={color} />
      <rect x="3" y="5" width="2" height="2" fill={keyhole} />
    </svg>
  );
}

export function CheckIcon({
  size = 14,
  color = "#3D7A34",
}: {
  size?: number;
  color?: string;
}) {
  return (
    <svg
      viewBox="0 0 8 8"
      width={size}
      height={size}
      shapeRendering="crispEdges"
      aria-hidden="true"
    >
      <rect x="0" y="4" width="1" height="2" fill={color} />
      <rect x="1" y="5" width="1" height="2" fill={color} />
      <rect x="2" y="6" width="1" height="2" fill={color} />
      <rect x="3" y="5" width="1" height="2" fill={color} />
      <rect x="4" y="3" width="1" height="2" fill={color} />
      <rect x="5" y="1" width="1" height="2" fill={color} />
      <rect x="6" y="0" width="1" height="2" fill={color} />
    </svg>
  );
}
