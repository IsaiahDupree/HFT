// Curated, structured comparison data for crypto venues evaluated for HFT-style
// execution. Numbers reflect typical retail / starter-tier conditions and the
// user's research notes (Coinbase Exchange FIX vs Advanced REST, Hyperliquid
// fee tiers, Paradex Pro flow, etc.). Treat values as defensible reference
// points for the UI — bots in production should re-pull live fees per venue.

export type VenueKind = "cex" | "dex" | "prediction";
export type GasPosture = "none" | "relayer" | "onchain";
export type ApiSurface = "REST" | "WebSocket" | "FIX" | "JSON-RPC" | "Onchain" | "MCP";

export type Venue = {
  id: string;
  name: string;
  chain: string;
  kind: VenueKind;
  gas: GasPosture;
  /** Fees in basis points (1 bp = 0.01%). Typical retail tier shown. */
  makerBps: number;
  takerBps: number;
  /** Negative = rebate paid to maker. */
  makerRebateBps: number;
  /** Approximate p50 round-trip order placement, milliseconds. */
  latencyMsP50: number;
  /** 1 = unsuitable, 5 = excellent HFT lane. */
  hftSuitability: 1 | 2 | 3 | 4 | 5;
  apis: ApiSurface[];
  /** Best-tier conditions to reach near-zero or rebate state. */
  bestTierNote: string;
  jurisdictionNotes: string;
  /** Whether a US-based retail user can compliantly trade here. */
  compliantUS: "yes" | "partial" | "no";
  /** Strategy fits this venue supports best. */
  bestStrategies: string[];
  risks: string[];
  notes: string;
  docs: string;
};

export const VENUES: Venue[] = [
  {
    id: "coinbase-advanced",
    name: "Coinbase Advanced Trade",
    chain: "Off-chain (CEX)",
    kind: "cex",
    gas: "none",
    makerBps: 40,
    takerBps: 60,
    makerRebateBps: 0,
    latencyMsP50: 90,
    hftSuitability: 2,
    apis: ["REST", "WebSocket"],
    bestTierNote:
      "Maker can reach 0 bps at high volume tiers; Coinbase One Premium rebates 25% on Advanced.",
    jurisdictionNotes:
      "Available to US persons; Coinbase Advanced Trade is the consumer-facing API. Lower-frequency than Coinbase Exchange.",
    compliantUS: "yes",
    bestStrategies: [
      "Automated maker quotes on ETH/USDC and BTC/USD",
      "Lead-lag against Kraken/Binance fair value",
      "Inventory rebalancing across stablecoins",
    ],
    risks: [
      "REST latency too slow for sub-100ms strategies",
      "Taker fees often exceed micro-scalp edge",
      "Rate limits tighten under bursts",
    ],
    notes:
      "Best for automation, not true HFT. Pair with WebSocket L2 feed for fast cancels.",
    docs: "https://docs.cdp.coinbase.com/advanced-trade/docs/welcome",
  },
  {
    id: "coinbase-exchange",
    name: "Coinbase Exchange (FIX)",
    chain: "Off-chain (CEX)",
    kind: "cex",
    gas: "none",
    makerBps: 0,
    takerBps: 5,
    makerRebateBps: 0,
    latencyMsP50: 8,
    hftSuitability: 5,
    apis: ["FIX", "REST", "WebSocket"],
    bestTierNote:
      "Pro tier with FIX 4.4 order entry + FIX market data. Maker fees reach 0 bps on volume; institutional pricing available.",
    jurisdictionNotes:
      "US-available institutional API. Co-location / cross-connect available in select regions.",
    compliantUS: "yes",
    bestStrategies: [
      "Spot market making ETH/USDC",
      "Cross-exchange arb vs Binance/Kraken",
      "Stale-quote sniping during news",
    ],
    risks: [
      "Cancel/replace abuse penalties",
      "Adverse selection at the top of book",
      "Institutional sign-up + KYB friction",
    ],
    notes:
      "Coinbase's true HFT lane. FIX Order Entry for latency-sensitive execution, FIX Market Data for low-latency feeds.",
    docs: "https://docs.cloud.coinbase.com/exchange/docs/welcome",
  },
  {
    id: "hyperliquid",
    name: "Hyperliquid / HyperCore",
    chain: "Hyperliquid L1",
    kind: "dex",
    gas: "none",
    makerBps: 1.5,
    takerBps: 4.5,
    makerRebateBps: -0.3,
    latencyMsP50: 60,
    hftSuitability: 5,
    apis: ["REST", "WebSocket"],
    bestTierNote:
      "Maker fees decline by 14-day rolling volume; tier-progressed accounts receive maker rebates paid continuously to the wallet.",
    jurisdictionNotes:
      "Decentralised perps + spot CLOB. Terms restrict certain regions; US access via app frontend is geographically gated.",
    compliantUS: "partial",
    bestStrategies: [
      "Perp market making BTC/ETH with funding capture",
      "Lead-lag vs Binance/Bybit fair value",
      "Cross-venue basis (perp vs CEX spot)",
      "Maker-rebate farming at tier-promoted volume",
    ],
    risks: [
      "Adverse selection — bots fill you only when wrong",
      "Funding-rate whipsaws on volatile days",
      "Validator throughput caps order-rate during spikes",
    ],
    notes:
      "Best crypto-native HFT-style venue. No gas drag means quote/cancel velocity is essentially free.",
    docs: "https://hyperliquid.gitbook.io/hyperliquid-docs",
  },
  {
    id: "paradex",
    name: "Paradex (Pro API)",
    chain: "Paradex (StarkEx L2)",
    kind: "dex",
    gas: "none",
    makerBps: 0,
    takerBps: 3,
    makerRebateBps: 0,
    latencyMsP50: 50,
    hftSuitability: 4,
    apis: ["REST", "WebSocket"],
    bestTierNote:
      "Maker fees currently 0 bps for spot/perps on Pro flow. Pro Orders bypass the 300ms retail speed bump and use a Pro fee schedule.",
    jurisdictionNotes:
      "Pro flow targets API market makers. Retail/Pro flow segregated for adverse-selection control.",
    compliantUS: "partial",
    bestStrategies: [
      "API market making (post-only) with 0% maker",
      "FastFills-style taker on retail flow (taker discount applies)",
      "Cross-listing arb between Paradex and Hyperliquid perps",
    ],
    risks: [
      "Pro flow competes against other algos — toxic flow",
      "0% maker may not last; check live schedule before sizing up",
      "L2 settlement adds withdrawal latency",
    ],
    notes:
      "Strong for maker-only API strategies. Pro/Retail separation is a microstructure edge if modelled correctly.",
    docs: "https://docs.paradex.trade/",
  },
  {
    id: "dydx",
    name: "dYdX Chain",
    chain: "dYdX Cosmos appchain",
    kind: "dex",
    gas: "none",
    makerBps: 0.5,
    takerBps: 2.5,
    makerRebateBps: -0.2,
    latencyMsP50: 70,
    hftSuitability: 4,
    apis: ["REST", "WebSocket", "JSON-RPC"],
    bestTierNote:
      "Volume-tiered maker rebates. High throughput appchain dedicated to perps.",
    jurisdictionNotes:
      "Terms restrict US persons and several other jurisdictions for perpetuals. VPN circumvention is explicitly prohibited.",
    compliantUS: "no",
    bestStrategies: [
      "Perp market making (non-US)",
      "Cross-chain perp arb vs Hyperliquid / Binance",
    ],
    risks: [
      "US persons are not permitted to use the perpetual product",
      "Lower depth than Binance / Hyperliquid on most pairs",
    ],
    notes:
      "Strong tech, but excluded for US-resident operators. Do not architect around geo-spoofing.",
    docs: "https://docs.dydx.exchange/",
  },
  {
    id: "polymarket",
    name: "Polymarket (binary prediction)",
    chain: "Polygon (relayer-paid gas)",
    kind: "prediction",
    gas: "relayer",
    makerBps: 0,
    takerBps: 100,
    makerRebateBps: -20,
    latencyMsP50: 350,
    hftSuitability: 3,
    apis: ["REST", "WebSocket", "Onchain"],
    bestTierNote:
      "Makers are never charged fees; takers pay 100 bps on crypto markets, of which 20% is paid back as maker rebate. Gas is paid by Polymarket's relayer.",
    jurisdictionNotes:
      "Available globally with some regional restrictions; US persons restricted from new accounts via app, but operators outside the US trade freely.",
    compliantUS: "partial",
    bestStrategies: [
      "BTC 'Up by close' / 'Down by close' maker on the lean side of fair-prob",
      "5m/15m binary scalping during volatility bursts",
      "News-speed repricing on resolution-source feeds",
      "Cross-market consistency (correlated event YES/NO)",
    ],
    risks: [
      "Event risk — single news headline invalidates the quote",
      "Settlement is discrete (binary), not continuous",
      "Liquidity thins outside marquee events",
    ],
    notes:
      "Not ETH/USDC spot HFT — prediction-market microstructure. Maker rebate + 0% maker fee makes it viable for fast quoting if your fair-prob model is good.",
    docs: "https://docs.polymarket.com/",
  },
  {
    id: "solana-clob",
    name: "Solana CLOBs (Phoenix / Drift / Zeta)",
    chain: "Solana",
    kind: "dex",
    gas: "onchain",
    makerBps: 0,
    takerBps: 2,
    makerRebateBps: 0,
    latencyMsP50: 400,
    hftSuitability: 3,
    apis: ["JSON-RPC", "WebSocket", "Onchain"],
    bestTierNote:
      "Very low per-transaction cost; not truly gasless. Priority fees during congestion can dominate edge.",
    jurisdictionNotes:
      "Mixed jurisdiction posture per venue; check Phoenix / Drift / Zeta terms individually.",
    compliantUS: "partial",
    bestStrategies: [
      "Phoenix CLOB market making",
      "Drift / Zeta perp market making",
      "Cross-DEX arb within Solana ecosystem",
    ],
    risks: [
      "Priority-fee spikes during congestion destroy maker EV",
      "RPC node quality dominates latency",
      "Slot-leader / MEV can front-run unprotected orders",
    ],
    notes:
      "Fast and cheap, not free. Best when you operate your own validator/RPC and bundle through Jito.",
    docs: "https://docs.phoenix.trade/",
  },
];

export function venueById(id: string): Venue | undefined {
  return VENUES.find((v) => v.id === id);
}

/** Round-trip fee in basis points for a single trade at a given venue. */
export function roundTripFeeBps(v: Venue, side: "maker" | "taker"): number {
  if (side === "maker") {
    // maker fee minus maker rebate (rebate is stored as negative bps)
    return v.makerBps + v.makerRebateBps;
  }
  return v.takerBps;
}
