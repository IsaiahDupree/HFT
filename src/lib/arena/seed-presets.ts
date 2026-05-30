/**
 * Aggressive preset genomes — hand-tuned at the LOW end of every strategy's
 * threshold bounds so they fire often. Injected into every new generation
 * (alongside mutated survivors) so the gene pool always has known-active
 * reference points to compete against. Without these the population can drift
 * toward strictly-cautious genomes that never trade.
 *
 * Spec: `docs/prds/arena-agent-decision-framework.md` §6.1.R1.4.
 */
import type { Genome } from "./genome";

export type Preset = { genome: Genome; nick: string };

/**
 * Returns 4 hand-tuned low-threshold genomes that *should* fire on any
 * non-pathological market state. Order matters for `g{n}-preset{i}-{nick}`
 * naming. Caller iterates and inserts via `insertPaperAgent` with
 * `introduced_by="preset-aggressive"` so mutation-stats can group them.
 */
export function aggressivePresets(opts: { polyConditionIdPool?: string[] } = {}): Preset[] {
  return [
    // (1) Momentum scalper on BTC — fires on any 0.1% velocity move w/ small
    // positive acceleration. The "always-on" momentum agent.
    {
      nick: "agg-mom-btc",
      genome: {
        kind: "cb_momentum_burst",
        params: {
          product_id: "BTC-USD",
          vel_window_min: 5,
          vel_entry_pct: 0.001,   // 0.1% over 5 min — extremely mild
          accel_min: 0.00005,     // tiny positive accel required
          entry_size_usd: 20,
          target_pct: 0.003,      // 0.3% target
          stop_pct: 0.004,        // 0.4% stop
          time_stop_min: 30,
          direction_bias: "long_short",
        },
      },
    },
    // (2) Mean-reversion at z=1.0 — fires on any noticeable deviation. The
    // "mild contrarian" agent.
    {
      nick: "agg-mr-eth",
      genome: {
        kind: "cb_mean_reversion",
        params: {
          product_id: "ETH-USD",
          lookback_min: 120,
          z_entry: 1.0,           // 1σ — mild stretch
          z_exit: 0.0,            // exit when back to mean
          entry_size_usd: 20,
          stop_pct: 0.02,
          time_stop_min: 240,
        },
      },
    },
    // (3) Poly fade-spike at minimum threshold — fades any meaningful poly
    // move. Tests whether even small fades carry edge.
    {
      nick: "agg-fade",
      genome: {
        kind: "poly_fade_spike",
        params: {
          threshold_pts: 3,       // bottom of bound
          lookback_h: 6,          // bottom of bound (less history needed)
          confirm_quiet_h: 2,
          entry_size_usd: 15,
          exit_target_pts: 2,
          stop_pts: 4,
          time_stop_h: 24,
        },
      },
    },
    // (4) High trade-prob random walk — the null hypothesis with teeth. If
    // this beats all other agents, our strategy bounds are mis-tuned.
    {
      nick: "agg-rand",
      genome: {
        kind: "random_walk_baseline",
        params: {
          trade_prob: 0.10,       // 10% per tick — fires ~once every 10 ticks
          buy_bias_pct: 0.50,
          entry_size_usd: 10,
        },
      },
    },
    // (5) Wallet copy filtered — mirrors a verified-active basket wallet
    // (memory: project_wallet_intelligence, fingerprinted as
    // `correlated_basket`). HorizonSplendidView's canonical proxy address
    // had 0 fills in 50k recent blocks (2026-05-25 backfill), suggesting the
    // article's address is stale or wallet dormant. Switching to the
    // verified-active 0xb55f… address keeps this preset informative.
    {
      nick: "agg-copy-basket",
      genome: {
        kind: "wallet_copy_filtered",
        params: {
          wallet_address: "0xb55fa1296e6ec55d0ce53d93b9237389f11764d4",
          copy_category: "crypto",
          size_pct_of_source: 0.005,
          max_size_usd: 10,
          delay_min: 30,
          min_source_win_rate: 0.55,
          min_source_trades: 10,
        },
      },
    },
    // (6) Multi-strategy composite — the "agent picks the strategy" archetype.
    // Combines three of the proven Phase-1 winners into one composite that
    // walks them in priority order and returns the first non-hold signal.
    // PRD arena-agent-decision-framework §6.2.L2.
    {
      nick: "agg-multi-mr-mom-rand",
      genome: {
        kind: "multi_strategy",
        params: {
          subs: [
            // (a) Mean-reversion on ETH at z=1.0 — the mild contrarian
            {
              kind: "cb_mean_reversion",
              params: {
                product_id: "ETH-USD",
                lookback_min: 120, z_entry: 1.0, z_exit: 0.0,
                entry_size_usd: 20, stop_pct: 0.02, time_stop_min: 240,
              },
            },
            // (b) Momentum-burst on BTC at lowest threshold
            {
              kind: "cb_momentum_burst",
              params: {
                product_id: "BTC-USD",
                vel_window_min: 5, vel_entry_pct: 0.001, accel_min: 0.00005,
                entry_size_usd: 20, target_pct: 0.003, stop_pct: 0.004,
                time_stop_min: 30, direction_bias: "long_short",
              },
            },
            // (c) Random walk fallback — guarantees activity when both above hold
            {
              kind: "random_walk_baseline",
              params: { trade_prob: 0.05, buy_bias_pct: 0.5, entry_size_usd: 10 },
            },
          ],
          selection: "priority",
          entry_size_usd: 25,
        },
      },
    },
    // (7) Polymarket market maker (CemeterySun archetype, sim-only). Quotes
    // both sides via alternating small entries on any liquid poly market.
    // token_id="any" tells decide() to resolve at tick time. PRD §6.4.R4.
    {
      nick: "agg-mm-any",
      genome: {
        kind: "polymarket_market_maker",
        params: {
          token_id: "any",
          spread_pts: 2,
          stop_pts: 4,
          time_stop_h: 4,
          entry_size_usd: 5,
        },
      },
    },
    // (8) LLM probability oracle — Lunar article's "20-line Claude brain".
    // AI estimates pTrue; the P2 EV+Kelly rail engages downstream. Inert
    // unless ARENA_LLM_ORACLE_ENABLED=1 (cost gate). One call per tick from
    // the warmer; this agent just reads the cache.
    //
    // Model = haiku-4-5: verified 2026-05-26 that the OAuth Claude Max scope
    // only allows direct SDK calls to haiku (sonnet/opus return 429 even with
    // headroom). Set ANTHROPIC_API_KEY (separately billed) if you want to
    // route this through sonnet/opus.
    {
      nick: "agg-oracle-haiku",
      genome: {
        kind: "llm_probability_oracle",
        params: {
          model: "claude-haiku-4-5-20251001",
          min_ev_pct: 0.05,
          max_calls_per_tick: 1,
          prompt_version: "v1",
          cache_ttl_min: 60,
          entry_size_usd: 25,
        },
      },
    },
    // (8) Category specialist (majorexploiter archetype) — focuses on the
    // category with most live markets in our snapshot universe. We pick
    // 'crypto' as default since Polymarket's crypto markets are the most
    // liquid and our snapshot worker pulls them heavily.
    {
      nick: "agg-cat-crypto",
      genome: {
        kind: "category_specialist",
        params: {
          category: "crypto",
          inner_strategy: "fade_spike",
          threshold_pts: 3,       // minimum fadeable move
          lookback_h: 6,          // shortest lookback
          confirm_quiet_h: 2,
          entry_size_usd: 15,
          exit_target_pts: 2,
          stop_pts: 4,
          time_stop_h: 24,
          breakout_mult: 1.10,    // unused for fade_spike inner; keep within bounds
        },
      },
    },
    // Rolling 5-min Up/Down binary directional agent — reads BTC/ETH/SOL/XRP/DOGE
    // velocity off Coinbase candles, buys YES on positive momentum, SELLs (= buy
    // NO equivalent) on negative. Position is force-closed by the resolver at
    // the actual outcome when the binary expires.
    {
      nick: "agg-5m-binary",
      genome: {
        kind: "poly_short_binary_directional",
        params: {
          assets: "BTC,ETH,SOL,XRP,DOGE,BNB,HYPE",   // full universe — Coinbase + OKX candle feeds
          // Re-tuned 2026-05-26 (afternoon): backtest over 1890 resolved
          // binaries (vs the 678 used for the morning tune). The bigger
          // dataset flipped the recommendation:
          //   vel_window=5, vel_entry=0.05% → 49.2% WR, +$1,138.85, +34.4% edge (n=663)
          //   vel_window=3, vel_entry=0.10% → 43.4% WR, +$234.50,  +26.8% edge (n=175)  ← prior
          // Wider window + looser threshold both increase trade volume AND
          // edge per trade. The 5-min velocity smoothed by 5 candles is a
          // better signal than 3 candles at a higher threshold.
          vel_window_min: 5,
          vel_entry_pct: 0.0005,            // 0.05% velocity over 5 min
          pre_cutoff_min: 3,                // skip the 2-min cutoff zone
          max_window_min: 6,                // only act on near-term binaries
          max_yes_price_for_buy: 0.70,      // refuse to chase already-priced-in moves
          min_yes_price_for_sell: 0.30,
          entry_size_usd: 5,                // small bets — many of them
          max_positions_per_asset: 1,       // one in-flight binary per asset
        },
      },
    },
  ];
}
