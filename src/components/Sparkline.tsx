/**
 * Tiny SVG sparkline. No deps, no chart library. Takes [number] and renders.
 */
type Props = {
  values: number[];
  width?: number;
  height?: number;
  className?: string;
  stroke?: string;
};

export function Sparkline({ values, width = 200, height = 40, className, stroke = "currentColor" }: Props) {
  if (values.length < 2) {
    return <svg width={width} height={height} className={className} aria-hidden />;
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const step = width / (values.length - 1);
  const points = values.map((v, i) => `${(i * step).toFixed(2)},${(height - ((v - min) / span) * height).toFixed(2)}`).join(" ");
  const latest = values[values.length - 1];
  const first = values[0];
  const dir = latest >= first ? "up" : "down";
  return (
    <svg width={width} height={height} className={className} viewBox={`0 0 ${width} ${height}`}>
      <polyline
        fill="none"
        stroke={stroke}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        points={points}
        opacity="0.85"
      />
      <circle
        cx={(values.length - 1) * step}
        cy={height - ((latest - min) / span) * height}
        r="2.5"
        fill={dir === "up" ? "#46d39a" : "#ff6e6e"}
      />
    </svg>
  );
}
