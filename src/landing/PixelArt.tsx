import type { CSSProperties } from 'react';

// Small pixel-art pieces for the landing hero. Pixels fade in one by one and a
// few keep twinkling. Cell codes: X blue, b mid blue, o soft blue, w white.

const COLORS: Record<string, string> = {
  X: 'var(--blue)',
  b: 'var(--blue-mid)',
  o: 'var(--blue-soft)',
  w: '#fff',
};

interface PixelGridProps {
  rows: string[];
  className?: string;
  /** Delay before the first pixel appears, in ms. */
  delay?: number;
  label: string;
}

function PixelGrid({ rows, className, delay = 0, label }: PixelGridProps) {
  const width = Math.max(...rows.map((r) => r.length));
  let index = 0;
  return (
    <svg
      className={`lp-pixels ${className ?? ''}`}
      viewBox={`0 0 ${width} ${rows.length}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label={label}
    >
      {rows.flatMap((row, y) =>
        [...row].map((cell, x) => {
          if (cell === '.') return null;
          const i = index++;
          const style = {
            '--d': `${delay + i * 18}ms`,
            fill: COLORS[cell] ?? COLORS.X,
          } as CSSProperties;
          const twinkle = (x * 31 + y * 17) % 9 === 0;
          return (
            <rect key={`${x}-${y}`} x={x + 0.06} y={y + 0.06} width={0.88} height={0.88} className={twinkle ? 'twinkle' : undefined} style={style} />
          );
        })
      )}
    </svg>
  );
}

// A screenshot: a little dashboard with a rising bar chart.
const SCREENSHOT = [
  'XXXXXXXXXXXX',
  'XbXbX......X',
  'X..........X',
  'X........X.X',
  'X......o.X.X',
  'X....o.o.X.X',
  'X..o.o.o.X.X',
  'X..........X',
  'X.oooo.oo..X',
  'XXXXXXXXXXXX',
];

// The bird, facing right.
const BIRD = [
  '.......XXXX.....',
  '.....XXXXXXXX...',
  '....XXXXXXwXXX..',
  '....XXXXXXXXXXbb',
  'X...XXXXXXXXXX..',
  'XX.XXXXXXXXXXX..',
  'XXXXXoooooXXXX..',
  '.XXXXXooooXXXX..',
  '..XXXXXoooXXX...',
  '....XXXXXXXX....',
  '......X..X......',
  '.....XX.XX......',
];

export function PixelScreenshot() {
  return <PixelGrid rows={SCREENSHOT} className="lp-pixels-shot" delay={200} label="A screenshot of a dashboard" />;
}

export function PixelBird() {
  return <PixelGrid rows={BIRD} className="lp-pixels-bird" delay={900} label="The IdeaBird pixel bird" />;
}
