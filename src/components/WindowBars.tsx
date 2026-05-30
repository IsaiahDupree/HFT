/**
 * Vertical bars showing the size of the last N completed 5-min windows
 * (close − open per window). Mimics the small bar chart in the Polymarket
 * 5m Up/Down market page. Pure server-rendered SVG.
 */
type Bar = { label: string; deltaUsd: number };

export function WindowBars({ bars, width = 280, height = 60 }: { bars: Bar[]; width?: number; height?: number }) {
  if (bars.length === 0) {
    return <div className="text-[10px] text-zinc-500 italic">no completed windows yet</div>;
  }
  const max = Math.max(1, ...bars.map((b) => Math.abs(b.deltaUsd)));
  const barW = Math.max(2, Math.floor((width - 2 * bars.length) / bars.length));
  const midY = height / 2;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      {/* zero line */}
      <line x1={0} x2={width} y1={midY} y2={midY} stroke="#27272a" strokeWidth="0.5" />
      {bars.map((b, i) => {
        const x = i * (barW + 2);
        const h = (Math.abs(b.deltaUsd) / max) * (height / 2 - 4);
        const up = b.deltaUsd >= 0;
        const y = up ? midY - h : midY;
        // Single string interpolation — splitting via {a}{b ? "x" : "y"}{c}
        // creates multiple JSX children which React serializes as separate
        // text nodes. SSR + hydrate can disagree on whitespace between them,
        // producing a hydration mismatch. Collapse to one expression so the
        // child is a single string value.
        const titleText = `${b.label}: $${b.deltaUsd >= 0 ? "+" : ""}${b.deltaUsd.toFixed(2)}`;
        return (
          <g key={i}>
            <rect x={x} y={y} width={barW} height={h} fill={up ? "#46d39a" : "#ff6e6e"} opacity={0.85} />
            <title>{titleText}</title>
          </g>
        );
      })}
    </svg>
  );
}
