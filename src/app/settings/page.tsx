/**
 * /settings — operator console for tuning + observability.
 *
 * Surfaces in one place everything we learned this session about how the
 * agents + strategies work:
 *
 *   1. Strategy thresholds        — current spec_json per gen-2 strategy
 *   2. Scanner + worker heartbeat — last activity from evolution_log
 *   3. Capsule status             — paper/live/paused + utilization
 *   4. Typology landscape         — count + top per bucket
 *   5. Recent learnings           — auto-aggregated research_notes
 *   6. Operational cheat-sheet    — the commands to run things
 *
 * Read-only in v1. Editable tunable thresholds (settings table + worker
 * integration) is a follow-up — the most-valuable v1 is showing the
 * operator EVERYTHING in one screen so they understand the system state.
 */
import Link from "next/link";
import { db } from "@/lib/db/client";

export const dynamic = "force-dynamic";
export const revalidate = 60;

type StrategyRow = {
  agent_slug: string;
  agent_name: string;
  agent_risk_usd: number;
  strategy_slug: string;
  strategy_name: string;
  spec_json: string;
  thesis: string;
};

type CapsuleRow = {
  id: string;
  name: string;
  agent_slug: string | null;
  status: string;
  capital_allocated_usd: number;
  capital_deployed_usd: number;
  daily_pnl_usd: number;
  trades_today: number;
  open_positions: number;
  max_daily_loss_usd: number;
};

type EventBeat = { event_type: string; last_at: string | null; count_24h: number };
type NoteRow = { id: number; topic: string; confidence: number | null; tags_json: string | null; created_at: string };
type TypologyDist = { primaryBucket: string; copyabilityClass: string; n: number };

function loadGen2Strategies(): StrategyRow[] {
  return db()
    .prepare(
      `SELECT a.slug AS agent_slug, a.name AS agent_name, a.risk_budget_usd AS agent_risk_usd,
              s.slug AS strategy_slug, s.name AS strategy_name, s.thesis,
              v.spec_json
         FROM agents a
         JOIN strategies s ON s.agent_id = a.id
         JOIN strategy_versions v ON v.strategy_id = s.id AND v.is_current = 1
        WHERE a.slug IN ('nereid-scrape', 'lyra-cross-timeframe', 'pulse-microstructure', 'hydra-consensus')
        ORDER BY a.id ASC`,
    )
    .all() as StrategyRow[];
}

function loadHeartbeats(): EventBeat[] {
  const types = [
    "near-resolution-opportunity",
    "near-resolution-scan-empty",
    "cross-timeframe-spread",
    "cross-timeframe-scan-empty",
    "orderbook-imbalance-signal",
    "orderbook-scan-empty",
    "wallet-typology",
    "wallet-trade-classified",
    "consensus-signal",
    "consensus-scan-empty",
    "nrs-auto-exec",
    "consensus-auto-exec",
    "order-context-snapshot",
  ];
  const handle = db();
  return types.map((t) => {
    const last = handle
      .prepare(`SELECT created_at FROM evolution_log WHERE event_type = ? ORDER BY id DESC LIMIT 1`)
      .get(t) as { created_at: string } | undefined;
    const count = (handle
      .prepare(`SELECT COUNT(*) AS n FROM evolution_log WHERE event_type = ? AND created_at >= datetime('now', '-1 day')`)
      .get(t) as { n: number }).n;
    return { event_type: t, last_at: last?.created_at ?? null, count_24h: count };
  });
}

function loadCapsules(): CapsuleRow[] {
  return db()
    .prepare(
      `SELECT c.id, c.name, a.slug AS agent_slug, c.status,
              c.capital_allocated_usd, c.capital_deployed_usd,
              c.daily_pnl_usd, c.trades_today, c.open_positions,
              c.max_daily_loss_usd
         FROM capsules c
         LEFT JOIN agents a ON a.id = c.agent_id
        WHERE c.status IN ('paper', 'live', 'paused')
        ORDER BY CASE c.status WHEN 'live' THEN 1 WHEN 'paper' THEN 2 ELSE 3 END,
                 c.capital_deployed_usd DESC`,
    )
    .all() as CapsuleRow[];
}

function loadTypologyDistribution(): TypologyDist[] {
  // Latest typology per wallet, then group.
  const handle = db();
  const rows = handle
    .prepare(
      `SELECT payload_json FROM evolution_log
        WHERE event_type = 'wallet-typology'
        ORDER BY created_at DESC, id DESC`,
    )
    .all() as Array<{ payload_json: string }>;
  const latestByWallet = new Map<string, { bucket: string; cls: string }>();
  for (const r of rows) {
    try {
      const p = JSON.parse(r.payload_json);
      if (!p?.wallet || latestByWallet.has(p.wallet)) continue;
      latestByWallet.set(p.wallet, { bucket: p.primaryBucket, cls: p.copyabilityClass });
    } catch {
      /* ignore */
    }
  }
  const dist = new Map<string, TypologyDist>();
  for (const { bucket, cls } of latestByWallet.values()) {
    const key = `${bucket}|${cls}`;
    const existing = dist.get(key);
    if (existing) existing.n++;
    else dist.set(key, { primaryBucket: bucket, copyabilityClass: cls, n: 1 });
  }
  return [...dist.values()].sort((a, b) => b.n - a.n);
}

function loadRecentLearnings(): NoteRow[] {
  return db()
    .prepare(
      `SELECT id, topic, confidence, tags_json, created_at FROM research_notes
        WHERE created_at >= datetime('now', '-7 days')
          AND tags_json LIKE '%scanner-summary%' OR tags_json LIKE '%auto-strategy-opportunity%'
        ORDER BY id DESC LIMIT 20`,
    )
    .all() as NoteRow[];
}

function fmtAgo(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return iso;
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function statusColor(status: string): string {
  if (status === "live") return "text-accent-green";
  if (status === "paper") return "text-accent-blue";
  if (status === "paused") return "text-accent-amber";
  return "text-zinc-400";
}

function heartbeatColor(lastAt: string | null): string {
  if (!lastAt) return "text-zinc-500";
  const ms = Date.now() - Date.parse(lastAt);
  if (ms < 60 * 60_000) return "text-accent-green"; // < 1h
  if (ms < 24 * 60 * 60_000) return "text-accent-blue"; // < 1d
  return "text-accent-amber"; // > 1d
}

function copyabilityColor(cls: string): string {
  if (cls === "potentially_copyable") return "text-accent-green";
  if (cls === "un_copyable") return "text-accent-red";
  if (cls === "flagged_high_risk") return "text-accent-red";
  if (cls === "needs_verification") return "text-accent-amber";
  return "text-zinc-400";
}

export default function SettingsPage() {
  const strategies = loadGen2Strategies();
  const beats = loadHeartbeats();
  const capsules = loadCapsules();
  const typology = loadTypologyDistribution();
  const learnings = loadRecentLearnings();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Operator settings + state</h1>
        <p className="text-xs text-zinc-500 mt-1">
          Single-screen view of strategy thresholds, scanner heartbeats, capsule utilization, tracked-wallet
          typology, and recent learnings. Read-only in v1 — edits go through the CLI / DB until tunable settings
          ship in v2.
        </p>
      </div>

      {/* ───── 1. Strategy thresholds (gen-2 agents) ───── */}
      <section className="card">
        <h2 className="card-title mb-3">Gen-2 strategy thresholds (live spec)</h2>
        {strategies.length === 0 ? (
          <p className="text-sm text-zinc-500">
            No gen-2 agents in DB. Run <code>npm run db:seed:gen2</code> to spawn them.
          </p>
        ) : (
          <div className="space-y-4">
            {strategies.map((s) => {
              let spec: any = {};
              try {
                spec = JSON.parse(s.spec_json);
              } catch {
                /* ignore */
              }
              return (
                <div key={s.strategy_slug} className="border-l-2 border-ink-700 pl-3">
                  <div className="flex items-baseline gap-3">
                    <span className="text-zinc-100 font-medium">{s.agent_name}</span>
                    <span className="text-xs text-zinc-500">/{s.strategy_slug}</span>
                    <span className="text-xs text-zinc-400">risk ${s.agent_risk_usd}</span>
                  </div>
                  <p className="text-xs text-zinc-400 mt-1">{s.thesis.slice(0, 200)}...</p>
                  <pre className="text-[10px] text-zinc-300 bg-ink-900/50 rounded p-2 mt-2 overflow-x-auto">
                    {JSON.stringify(spec, null, 2)}
                  </pre>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ───── 2. Scanner + worker heartbeats ───── */}
      <section className="card">
        <h2 className="card-title mb-2">Scanner + worker heartbeats (24h)</h2>
        <p className="text-xs text-zinc-500 mb-3">
          Green = ran in last hour. Blue = today. Amber = stale. Empty = never.
        </p>
        <table className="list w-full text-xs">
          <thead>
            <tr>
              <th>Event type</th>
              <th className="text-right">Last activity</th>
              <th className="text-right">Count (24h)</th>
            </tr>
          </thead>
          <tbody>
            {beats.map((b) => (
              <tr key={b.event_type}>
                <td className="font-mono">{b.event_type}</td>
                <td className={`text-right ${heartbeatColor(b.last_at)}`}>{fmtAgo(b.last_at)}</td>
                <td className="text-right tabular-nums">{b.count_24h}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* ───── 3. Capsule status ───── */}
      <section className="card">
        <h2 className="card-title mb-2">Capsule utilization ({capsules.length} active)</h2>
        {capsules.length === 0 ? (
          <p className="text-sm text-zinc-500">No active capsules. Create via /capsules UI or seed script.</p>
        ) : (
          <table className="list w-full text-xs">
            <thead>
              <tr>
                <th>Capsule</th>
                <th>Agent</th>
                <th>Status</th>
                <th className="text-right">Allocated</th>
                <th className="text-right">Deployed</th>
                <th className="text-right">Daily PnL</th>
                <th className="text-right">Daily-loss cap</th>
                <th className="text-right">Trades / open</th>
              </tr>
            </thead>
            <tbody>
              {capsules.map((c) => (
                <tr key={c.id}>
                  <td className="text-zinc-300">{c.name.slice(0, 40)}</td>
                  <td className="text-zinc-400">{c.agent_slug ?? "—"}</td>
                  <td className={statusColor(c.status)}>{c.status}</td>
                  <td className="text-right tabular-nums">${Number(c.capital_allocated_usd).toFixed(0)}</td>
                  <td className="text-right tabular-nums">${Number(c.capital_deployed_usd).toFixed(0)}</td>
                  <td
                    className={`text-right tabular-nums ${
                      Number(c.daily_pnl_usd) > 0
                        ? "text-accent-green"
                        : Number(c.daily_pnl_usd) < 0
                        ? "text-accent-red"
                        : ""
                    }`}
                  >
                    ${Number(c.daily_pnl_usd).toFixed(2)}
                  </td>
                  <td className="text-right tabular-nums text-zinc-500">${Number(c.max_daily_loss_usd).toFixed(0)}</td>
                  <td className="text-right tabular-nums">
                    {c.trades_today} / {c.open_positions}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* ───── 4. Typology landscape ───── */}
      <section className="card">
        <h2 className="card-title mb-2">
          Tracked-wallet typology distribution ({typology.reduce((s, t) => s + t.n, 0)} wallets)
        </h2>
        <p className="text-xs text-zinc-500 mb-3">
          Run <code>npm run classify:wallet</code> to refresh. Only{" "}
          <span className="text-accent-green">potentially_copyable</span> wallets should feed observer / consensus
          pipelines.
        </p>
        <table className="list w-full text-xs">
          <thead>
            <tr>
              <th>Bucket</th>
              <th>Class</th>
              <th className="text-right">Count</th>
            </tr>
          </thead>
          <tbody>
            {typology.map((t, i) => (
              <tr key={i}>
                <td className="text-zinc-300">{t.primaryBucket.replace(/_/g, " ")}</td>
                <td className={copyabilityColor(t.copyabilityClass)}>
                  {t.copyabilityClass.replace(/_/g, " ")}
                </td>
                <td className="text-right tabular-nums">{t.n}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* ───── 5. Recent learnings (auto-aggregated) ───── */}
      <section className="card">
        <h2 className="card-title mb-2">Recent learnings — auto-aggregated research notes (last 7d)</h2>
        {learnings.length === 0 ? (
          <p className="text-sm text-zinc-500">
            No scanner-summary notes yet. Run <code>npm run worker:research</code> after the scanners have produced
            some signals.
          </p>
        ) : (
          <table className="list w-full text-xs">
            <thead>
              <tr>
                <th>Time</th>
                <th>Topic</th>
                <th className="text-right">Confidence</th>
                <th>Tags</th>
              </tr>
            </thead>
            <tbody>
              {learnings.map((n) => {
                let tags: string[] = [];
                try {
                  tags = JSON.parse(n.tags_json ?? "[]");
                } catch {
                  /* ignore */
                }
                return (
                  <tr key={n.id}>
                    <td className="tabular-nums">{n.created_at.slice(5, 16).replace("T", " ")}</td>
                    <td className="text-zinc-300">{n.topic.slice(0, 80)}</td>
                    <td className="text-right tabular-nums">
                      {n.confidence != null ? `${(Number(n.confidence) * 100).toFixed(0)}%` : "—"}
                    </td>
                    <td className="text-zinc-500 text-[10px]">{tags.slice(0, 3).join(", ")}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      {/* ───── 6. Operational cheat-sheet ───── */}
      <section className="card text-xs text-zinc-400 space-y-3">
        <h2 className="card-title text-zinc-200">Operational cheat-sheet — the commands</h2>

        <div>
          <strong className="text-zinc-200 block mb-1">Periodic scans (recommended cron):</strong>
          <pre className="bg-ink-900/50 rounded p-2 overflow-x-auto text-[11px]">
{`*/15 * * * *  npm run scan:near-resolution        # NRS opportunities
*/30 * * * *  npm run scan:cross-timeframe        # CTS spread (needs poly_binaries)
* * * * *     npm run scan:orderbook-imbalance     # OBI signals (1-min cadence)
*/60 * * * *  npm run emit:opportunity-notes       # surface signals to /research
*/15 * * * *  npm run watch:aave-liq               # Aave HF for tracked wallets`}
          </pre>
        </div>

        <div>
          <strong className="text-zinc-200 block mb-1">Long-running workers (start once, leave running):</strong>
          <pre className="bg-ink-900/50 rounded p-2 overflow-x-auto text-[11px]">
{`npm run worker:nrs-exec                          # sim by default
npm run worker:consensus-exec                    # sim by default
npm run worker:research                          # research-loop, periodic agent evaluation
npm run observe:wallet -- --addresses 0xA,0xB    # per-trade classification on tracked wallets`}
          </pre>
        </div>

        <div>
          <strong className="text-accent-red block mb-1">To arm LIVE trading (real money — review capsules first):</strong>
          <pre className="bg-ink-900/50 rounded p-2 overflow-x-auto text-[11px]">
{`NRS_LIVE=1                  npm run worker:nrs-exec
CONSENSUS_AUTO_EXEC_LIVE=1  npm run worker:consensus-exec
# Kill switch: visit /safety to halt all venues immediately`}
          </pre>
        </div>

        <div>
          <strong className="text-zinc-200 block mb-1">Add a new tracked wallet:</strong>
          <pre className="bg-ink-900/50 rounded p-2 overflow-x-auto text-[11px]">
{`npm run classify:wallet -- --handle "https://polymarket.com/@<name>" --persist
# accepts: full URL, @handle, partial 0x, full 0x40 address`}
          </pre>
        </div>

        <div className="pt-2 border-t border-ink-700">
          <strong className="text-zinc-200 block mb-1">Quick links</strong>
          <div className="flex gap-3 flex-wrap">
            <Link href="/agents" className="text-accent-blue hover:underline">/agents</Link>
            <Link href="/capsules" className="text-accent-blue hover:underline">/capsules</Link>
            <Link href="/safety" className="text-accent-blue hover:underline">/safety</Link>
            <Link href="/opportunities" className="text-accent-blue hover:underline">/opportunities</Link>
            <Link href="/consensus" className="text-accent-blue hover:underline">/consensus</Link>
            <Link href="/tracked" className="text-accent-blue hover:underline">/tracked</Link>
            <Link href="/research" className="text-accent-blue hover:underline">/research</Link>
            <Link href="/evolution" className="text-accent-blue hover:underline">/evolution</Link>
          </div>
        </div>
      </section>

      {/* ───── 7. Why-agents-are-better explainer ───── */}
      <section className="card text-xs text-zinc-400 border-accent-blue/20">
        <h2 className="card-title text-zinc-200 mb-2">Why recent agents perform better (the honest answer)</h2>
        <p className="mb-2">
          Two distinct improvement vectors run in parallel:
        </p>
        <ol className="list-decimal pl-5 space-y-1.5">
          <li>
            <span className="text-zinc-200">Arena evolution</span> — paper agents go through generations.
            Mutated winners breed, losers die. After 70+ generations the population is enriched with what works.
            Top performers are all "agg-5m-binary" — the selection pressure converged on short-cycle crypto.
            Score-gated promotion (paper → live) ensures only winners get capital.{" "}
            <span className="text-accent-green">This shows up in actual realized PnL.</span>
          </li>
          <li>
            <span className="text-zinc-200">Signal-awareness</span> — every evaluator now reads typology /
            consensus / trade-classifications / strategy-opportunities arrays before deciding. The Oracle LLM
            prompt teaches the model what each signal means. The router writes order-context-snapshot per
            submit for audit + future ML training.{" "}
            <span className="text-accent-blue">
              This is structural; measurable improvement requires more live trading volume to surface.
            </span>
          </li>
        </ol>
        <p className="mt-3">
          The 4 gen-2 agents (Nereid / Lyra / Pulse / Hydra) are new this session — they add NEW strategy
          options proven externally (Nereid wraps the $2M-realized near-resolution scrape pattern from
          wallet <code>0x6e1d5040</code>; Hydra wraps the consensus pipeline). Live PnL data on these is TBD
          until the workers run on a cron with real capital.
        </p>
      </section>
    </div>
  );
}
