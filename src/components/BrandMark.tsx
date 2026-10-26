// IdeaBird's mark: a small pixel bird on a Base-blue square.
const BIRD = [
  '..XX....',
  '.XXXX...',
  'XX.XXX..',
  '.XXXXXXX',
  '..XXXXX.',
  '...XX...',
];

export function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <span className="brand-mark" style={{ width: size, height: size }} aria-hidden="true">
      <svg viewBox="-1 -2 10 10" width="70%" height="70%" shapeRendering="crispEdges">
        {BIRD.flatMap((row, y) =>
          [...row].map((cell, x) => (cell === 'X' ? <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" fill="#fff" /> : null))
        )}
      </svg>
    </span>
  );
}
