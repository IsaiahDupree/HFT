/**
 * hl-wallet-map — a VISUAL strategy map of Hyperliquid traders. HL is fully transparent on-chain, so every
 * wallet's positions + fills are public. For the top-N leaderboard wallets we build a behavioral fingerprint
 * (activity, directionality, concentration, realized PnL, archetype) and render an interactive scatter to an
 * HTML file: x = trades/day (log, speed), y = long-bias (directionality), colour = strategy archetype, size =
 * account value, ring = verified-profitable vs fake — so the CLUSTERS are the strategies. Hover any dot for its
 * full profile. NOTE: Binance + Coinbase are centralized — there is NO public per-wallet data, so they cannot
 * be mapped; dYdX is on-chain but has no public leaderboard (needs seed addresses).
 *
 *   npm run hl:wallet-map [-- --top 60]
 */
import "./_env.ts";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { parseLeaderboard, realizedStats, isVerifiedProfitable, fillStyleProfile, walletArchetype, type Fill } from "../src/lib/exec/smart-money.ts";
import { netCapitalFlow, flowDistortion, type LedgerUpdate } from "../src/lib/exec/capital-flow.ts";

const num = (n: string, d: number): number => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : d; };
const TOP = num("--top", 60);
const INFO = "https://api.hyperliquid.xyz/info", LB = "https://stats-data.hyperliquid.xyz/Mainnet/leaderboard";
const OUT = process.env.WALLET_MAP_OUT ?? (existsSync("/Volumes/My Passport") ? "/Volumes/My Passport/hft-data/hl-wallet-map.html" : resolve(process.cwd(), "data", "hl-wallet-map.html"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function jget(u: string): Promise<any> { const r = await fetch(u, { signal: AbortSignal.timeout(30_000) }); if (!r.ok) throw new Error(`${u.slice(0, 40)} ${r.status}`); return r.json(); }
async function info(b: unknown, tries = 4): Promise<any> { for (let i = 0; i < tries; i++) { const r = await fetch(INFO, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b), signal: AbortSignal.timeout(20_000) }); if (r.ok) return r.json(); if (r.status === 429 && i < tries - 1) { await sleep(1000 * (i + 1)); continue; } throw new Error(`info ${r.status}`); } }

type Dot = { addr: string; accountValue: number; tradesPerDay: number; longBias: number; winRate: number; profitFactor: number; realizedPnl: number; nFills: number; nCoins: number; topCoinShare: number; topCoins: string; archetype: string; verified: boolean; distorted: boolean; withdrawnUsd: number; topPos: string };

console.log(`\nhl-wallet-map — building a strategy map of the top ${TOP} Hyperliquid wallets → ${OUT}\n`);
const ranked = parseLeaderboard(await jget(LB)).slice(0, TOP);
const FLOW_START = Math.floor(Date.now() - 30 * 86_400_000);
const dots: Dot[] = [];
for (const w of ranked) {
  try {
    const st = await info({ type: "clearinghouseState", user: w.address });
    const acct = Number(st?.marginSummary?.accountValue ?? w.accountValue);
    const aps = (st?.assetPositions ?? []) as Array<{ position: { coin: string; szi: string; positionValue?: string; entryPx?: string } }>;
    const fills = ((await info({ type: "userFills", user: w.address })) as Array<Record<string, unknown>>).map((f) => ({ coin: String(f.coin), dir: String(f.dir ?? ""), sz: Number(f.sz), px: Number(f.px), closedPnl: Number(f.closedPnl ?? 0), time: Number(f.time) } as Fill));
    if (fills.length < 5) continue;
    const style = fillStyleProfile(fills), rs = realizedStats(fills);
    const coinCount = new Map<string, number>(); for (const f of fills) coinCount.set(f.coin, (coinCount.get(f.coin) ?? 0) + 1);
    const topCoinShare = Math.max(...coinCount.values()) / fills.length;
    const ledger = (await info({ type: "userNonFundingLedgerUpdates", user: w.address, startTime: FLOW_START })) as LedgerUpdate[];
    const flow = netCapitalFlow(ledger), dist = flowDistortion(flow, acct);
    const top = aps.map((a) => ({ coin: a.position.coin, szi: Number(a.position.szi), notional: Number(a.position.positionValue ?? 0) })).sort((a, b) => b.notional - a.notional)[0];
    dots.push({
      addr: w.address, accountValue: acct, tradesPerDay: style.tradesPerDay, longBias: style.longBias,
      winRate: rs.winRate, profitFactor: rs.profitFactor === Infinity ? 99 : rs.profitFactor, realizedPnl: rs.realizedPnl,
      nFills: fills.length, nCoins: coinCount.size, topCoinShare, topCoins: style.topCoins.slice(0, 3).join(","),
      archetype: walletArchetype({ tradesPerDay: style.tradesPerDay, longBias: style.longBias, topCoinShare }),
      verified: isVerifiedProfitable(rs), distorted: dist.distorted, withdrawnUsd: flow.withdrawals,
      topPos: top ? `${top.szi >= 0 ? "L" : "S"} ${top.coin} $${(top.notional / 1000).toFixed(0)}k` : "flat",
    });
    await sleep(50);
  } catch { /* skip */ }
}
console.log(`  built ${dots.length} wallet fingerprints`);
const byArch = dots.reduce((m, d) => { m[d.archetype] = (m[d.archetype] ?? 0) + 1; return m; }, {} as Record<string, number>);
console.log(`  archetypes: ${Object.entries(byArch).map(([a, n]) => `${a} ${n}`).join(" · ")}`);
console.log(`  verified-profitable: ${dots.filter((d) => d.verified).length}/${dots.length} · flow-distorted: ${dots.filter((d) => d.distorted).length}`);

const html = `<!doctype html><html><head><meta charset="utf8"><title>Hyperliquid Wallet Strategy Map</title>
<script src="https://cdn.jsdelivr.net/npm/d3@7"></script>
<style>body{background:#0b0e14;color:#cdd6f4;font:13px -apple-system,system-ui,sans-serif;margin:0;padding:16px}
h1{font-size:18px;margin:0 0 2px}.sub{color:#7f849c;margin:0 0 12px;font-size:12px}
#tt{position:fixed;pointer-events:none;background:#181825;border:1px solid #45475a;border-radius:8px;padding:8px 10px;font-size:12px;opacity:0;max-width:280px;box-shadow:0 4px 16px #000a}
.legend span{display:inline-block;margin-right:14px}.dot{cursor:pointer}.axis text{fill:#7f849c}.axis line,.axis path{stroke:#313244}</style></head>
<body><h1>Hyperliquid Wallet Strategy Map</h1>
<p class="sub">x = trades/day (log → speed) · y = long-bias (0 = all short, 1 = all long) · size = account value · solid ring = verified-profitable, dashed = unprofitable/fake · ✕ = withdrew capital (ROI distorted). The clusters are the strategies. Binance/Coinbase can't be mapped (centralized, no public per-wallet data).</p>
<div class="legend" id="legend"></div><svg id="chart"></svg>
<div id="tt"></div>
<script>
const data = ${JSON.stringify(dots)};
const COL = {"market-maker":"#89b4fa","hft-scalper":"#f38ba8","directional-swing":"#a6e3a1","position-trader":"#f9e2af","specialist":"#cba6f7","low-activity":"#7f849c"};
const W=Math.min(1200,innerWidth-32), H=620, M={t:20,r:20,b:46,l:54};
const svg=d3.select("#chart").attr("width",W).attr("height",H);
const x=d3.scaleLog().domain([Math.max(0.05,d3.min(data,d=>d.tradesPerDay)||0.1),Math.max(10,d3.max(data,d=>d.tradesPerDay)||1000)]).range([M.l,W-M.r]).clamp(true);
const y=d3.scaleLinear().domain([0,1]).range([H-M.b,M.t]);
const r=d3.scaleSqrt().domain([0,d3.max(data,d=>d.accountValue)||1e6]).range([3,26]);
svg.append("g").attr("class","axis").attr("transform","translate(0,"+(H-M.b)+")").call(d3.axisBottom(x).ticks(6,"~s"));
svg.append("g").attr("class","axis").attr("transform","translate("+M.l+",0)").call(d3.axisLeft(y).ticks(6).tickFormat(d3.format(".0%")));
svg.append("text").attr("x",W/2).attr("y",H-8).attr("fill","#7f849c").attr("text-anchor","middle").text("trades / day  (log)");
svg.append("text").attr("transform","rotate(-90)").attr("x",-H/2).attr("y",16).attr("fill","#7f849c").attr("text-anchor","middle").text("long-bias  (directionality)");
const tt=d3.select("#tt");
svg.append("g").selectAll("circle").data(data).join("circle").attr("class","dot")
  .attr("cx",d=>x(Math.max(0.05,d.tradesPerDay))).attr("cy",d=>y(d.longBias)).attr("r",d=>r(d.accountValue))
  .attr("fill",d=>COL[d.archetype]||"#7f849c").attr("fill-opacity",0.55)
  .attr("stroke",d=>d.verified?"#a6e3a1":"#f38ba8").attr("stroke-width",d=>d.verified?2:1.2).attr("stroke-dasharray",d=>d.verified?"none":"3,2")
  .on("mousemove",(e,d)=>{tt.style("opacity",1).style("left",(e.clientX+14)+"px").style("top",(e.clientY+14)+"px").html(
    "<b>"+d.addr.slice(0,12)+"…</b> "+(d.distorted?"<span style='color:#f38ba8'>✕ withdrew $"+(d.withdrawnUsd/1000).toFixed(0)+"k</span>":"")+
    "<br><b>"+d.archetype+"</b> "+(d.verified?"<span style='color:#a6e3a1'>✓ real</span>":"<span style='color:#f38ba8'>✗ fake</span>")+
    "<br>account $"+(d.accountValue/1000).toFixed(0)+"k · realized $"+(d.realizedPnl/1000).toFixed(1)+"k"+
    "<br>"+d.tradesPerDay.toFixed(0)+" trades/day · win "+(d.winRate*100).toFixed(0)+"% · PF "+d.profitFactor.toFixed(2)+
    "<br>long-bias "+(d.longBias*100).toFixed(0)+"% · "+d.nCoins+" coins (top "+(d.topCoinShare*100).toFixed(0)+"%: "+d.topCoins+")"+
    "<br>position: "+d.topPos);})
  .on("mouseleave",()=>tt.style("opacity",0));
d3.select("#legend").html(Object.entries(COL).map(([k,c])=>"<span><b style='color:"+c+"'>●</b> "+k+"</span>").join("")+" <span style='color:#a6e3a1'>━ verified</span> <span style='color:#f38ba8'>┄ fake</span>");
</script></body></html>`;
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, html);
console.log(`\n  ✓ wrote interactive map → ${OUT}\n  open it: open "${OUT}"\n`);
