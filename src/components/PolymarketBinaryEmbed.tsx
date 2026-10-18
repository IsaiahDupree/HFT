/**
 * Embed the official Polymarket market iframe for a short-duration binary.
 *
 * Polymarket provides an embed.polymarket.com endpoint that renders the
 * live YES/NO chart + countdown for a market by event slug. We mirror their
 * embed snippet but keep the iframe inert to the parent's CSP by passing
 * only the minimum query params.
 *
 * https://embed.polymarket.com/market?market=<event-slug>&theme=dark&buttons=false
 */
type Props = {
  eventSlug: string;
  /** Used for the iframe title + aria-label. */
  question: string;
  /** Default 400×300; pass smaller for grid layouts. */
  width?: number;
  height?: number;
};

export function PolymarketBinaryEmbed({ eventSlug, question, width = 400, height = 300 }: Props) {
  const src = `https://embed.polymarket.com/market?market=${encodeURIComponent(eventSlug)}&theme=dark&buttons=false&border=true`;
  const href = `https://polymarket.com/event/${encodeURIComponent(eventSlug)}`;
  return (
    <div className="relative inline-block" style={{ width, height }}>
      <iframe
        title={`${question} — Polymarket Prediction Market`}
        src={src}
        width={width}
        height={height}
        frameBorder={0}
        // Sandbox keeps the embedded page from poking at our origin while
        // still allowing scripts (Polymarket's UI needs them) and same-origin
        // (it talks to its own API).
        sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        loading="lazy"
        style={{ border: 0 }}
      />
      {/* Overlay "view on Polymarket" link in the top-right corner. */}
      <a
        href={href}
        aria-label="View on Polymarket"
        target="_blank"
        rel="noopener noreferrer"
        className="absolute top-2 right-2 px-2 py-0.5 text-[10px] rounded bg-ink-900/70 text-zinc-300 hover:text-zinc-100 border border-ink-700"
      >
        polymarket ↗
      </a>
    </div>
  );
}
