/**
 * Signal intake — the executing half of the polymarket-2dollar-bot → HFT-work
 * bridge. The 2dollar-bot is the SIGNAL brain (golden-window edge + its own
 * readiness gate); HFT-work is the single execution authority (CLOB-V2 +
 * ALLOW_TRADE + risk caps via submitSingleSideMarket). This validates an incoming
 * golden signal and maps it to a single-side market order.
 *
 * Two safety gates in series: the 2dollar-bot's `readiness_ok` (≥N profitable
 * settled trades) AND HFT-work's own caps/ALLOW_TRADE downstream. Plus the route's
 * SIGNAL_INTAKE_ENABLED switch (journal-only until explicitly on). Pure + tested.
 */

export type GoldenSignal = {
  source?: string;
  asset?: string;
  recurrence?: string;
  side: string; // UP | DOWN | YES | NO
  size_usd?: number;
  token_id?: string; // the chosen side's CLOB token — we BUY this
  entry_price?: number;
  est_win_prob?: number;
  edge?: number;
  readiness_ok?: boolean;
  window_end_ts?: number;
};

export type IntakeDecision = {
  accepted: boolean;
  reason: string;
  order?: { tokenId: string; side: "BUY"; sizeUsd: number; refPrice: number; rationale: string };
};

const SIDES = new Set(["UP", "DOWN", "YES", "NO"]);

/** Normalize a signal's regime key as "ASSET:recurrence" (e.g. "SOL:5m"). */
export function regimeOf(sig: GoldenSignal): string {
  return `${String(sig.asset ?? "").toUpperCase()}:${String(sig.recurrence ?? "").toLowerCase()}`;
}

/** Validate + map a golden signal to a submitSingleSideMarket order, applying the
 *  per-trade USD cap and an optional single-regime allowlist. Rejects (never throws)
 *  on any failed gate. The 2dollar-bot emits the CHOSEN side's token_id, so execution
 *  is always a BUY of that token.
 *
 *  `allow`: if non-empty, ONLY signals whose ASSET:recurrence is in it may route —
 *  this is how we restrict live trading to ONE coin+window and reject all others. */
export function planFromSignal(sig: GoldenSignal,
                               opts: { maxTradeUsd: number; allow?: string[] }): IntakeDecision {
  if (!sig || typeof sig !== "object") return { accepted: false, reason: "no signal body" };
  if (!sig.readiness_ok) return { accepted: false, reason: "2dollar-bot readiness gate not met (readiness_ok=false)" };
  const allow = (opts.allow ?? []).map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (allow.length > 0) {
    const regime = regimeOf(sig).toUpperCase();
    if (!allow.includes(regime)) {
      return { accepted: false, reason: `regime ${regime} not in allowlist [${allow.join(", ")}]` };
    }
  }
  const side = String(sig.side ?? "").toUpperCase();
  if (!SIDES.has(side)) return { accepted: false, reason: `bad side '${sig.side}'` };
  if (!sig.token_id) return { accepted: false, reason: "no token_id (can't resolve the side's CLOB token)" };
  const entry = Number(sig.entry_price);
  if (!(entry > 0 && entry < 1)) return { accepted: false, reason: `bad entry_price ${sig.entry_price}` };
  const requested = Number(sig.size_usd ?? 0);
  if (!(requested > 0)) return { accepted: false, reason: "size_usd resolves to 0" };
  const sizeUsd = Math.min(requested, opts.maxTradeUsd); // hard per-trade cap
  return {
    accepted: true,
    reason: "ok",
    order: {
      tokenId: sig.token_id,
      side: "BUY",
      sizeUsd,
      refPrice: entry,
      rationale: `${sig.source ?? "signal"} ${sig.asset ?? ""}:${sig.recurrence ?? ""} ${side} ` +
        `p=${sig.est_win_prob ?? "?"} edge=${sig.edge ?? "?"}`,
    },
  };
}
