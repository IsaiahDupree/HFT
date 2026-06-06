/**
 * _hl-fingerprint-loop-bench — the REAL-DATA AI-loop test: can claude-haiku (via OAuth), using different loop
 * designs, tell a GENUINELY-PROFITABLE Hyperliquid wallet from a FAKE winner (high win rate / negative
 * expectancy) from its BEHAVIORAL fingerprint alone — NOT its realized PnL? Ground truth = isVerifiedProfitable
 * (hidden from the model). 20-wallet sample, scored by accuracy + a PERMUTATION test (shuffle the labels) so a
 * lucky split can't masquerade as skill. Compares single / cot / ensemble loops vs a deterministic baseline.
 *
 *   npm run bench:fingerprint [-- --n 20 --pool 34]
 */
import "./_env.ts";
import { getOAuthClient, authIsAvailable } from "../src/lib/anthropic/auth.ts";
import { buildFingerprint, deterministicWinnerGuess, accuracy, permutationPValue, type Fill } from "../src/lib/exec/wallet-fingerprint.ts";
import { realizedStats, isVerifiedProfitable, type Fill as SmFill } from "../src/lib/exec/smart-money.ts";

const MODEL = "claude-haiku-4-5";
const num = (n: string, d: number): number => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : d; };
const N = num("--n", 20), POOL = num("--pool", 34);
const INFO = "https://api.hyperliquid.xyz/info", LB = "https://stats-data.hyperliquid.xyz/Mainnet/leaderboard";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function jget(url: string): Promise<any> { const r = await fetch(url, { signal: AbortSignal.timeout(30_000) }); if (!r.ok) throw new Error(`${url.slice(0, 40)} ${r.status}`); return r.json(); }
async function info(b: unknown, tries = 4): Promise<any> { for (let i = 0; i < tries; i++) { const r = await fetch(INFO, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b), signal: AbortSignal.timeout(20_000) }); if (r.ok) return r.json(); if (r.status === 429 && i < tries - 1) { await sleep(1200 * (i + 1)); continue; } throw new Error(`info ${r.status}`); } }

const SYSTEM = `You are a trading-forensics analyst. Given a Hyperliquid wallet's BEHAVIORAL fingerprint (trade
cadence, win rate, long bias, coin concentration, notional — but NOT its PnL), judge whether it is a GENUINELY
PROFITABLE trader (net positive, profit factor ≥ 1) or a FAKE winner. KEY TRAP: a very HIGH win rate (e.g. >0.85)
often hides NEGATIVE expectancy — many tiny wins then one huge loss ("pennies in front of a steamroller"). A
sustainable edge usually has a moderate win rate. Judge the PATTERN, not just the win rate. Output winner=true if
you judge it genuinely profitable.`;
const SCHEMA = { type: "object", additionalProperties: false, properties: { winner: { type: "boolean" }, reasoning: { type: "string" } }, required: ["winner", "reasoning"] };
let CALLS = 0;
async function ask(user: string, sys = SYSTEM): Promise<boolean> {
  CALLS++;
  const c = await getOAuthClient();
  const resp = await c.messages.create({ model: MODEL, max_tokens: 400, system: [{ type: "text", text: sys }], messages: [{ role: "user", content: user }], output_config: { format: { type: "json_schema", schema: SCHEMA } as any } } as any);
  const text = (resp.content as Array<{ type: string; text?: string }>).find((b) => b.type === "text")?.text ?? "{}";
  const m = text.match(/\{[\s\S]*\}/); return !!(m ? JSON.parse(m[0]).winner : false);
}
const fpPrompt = (fp: unknown) => `Wallet behavioral fingerprint (JSON):\n${JSON.stringify(fp, null, 1)}\nIs this a genuinely profitable trader?`;

// loop designs
const single = (fp: unknown) => ask(fpPrompt(fp));
const cot = (fp: unknown) => ask(`${fpPrompt(fp)}\nReason step by step: is the win rate sustainable or steamroller-high? Is the cadence a real strategy or churn? THEN decide.`);
async function ensemble(fp: unknown, k = 5): Promise<boolean> { const v = await Promise.all(Array.from({ length: k }, () => single(fp))); return v.filter(Boolean).length > k / 2; }

if (!authIsAvailable()) { console.log("\n[bench] no OAuth auth — cannot run the live AI loops.\n"); process.exit(0); }

// 1) build the labeled sample from real wallets
console.log(`\nhl-fingerprint-loop-bench — can haiku spot a real winner from the fingerprint? · sample ${N}\n`);
const rows = (await jget(LB)).leaderboardRows as Array<{ ethAddress: string }>;
const sample: Array<{ addr: string; fp: ReturnType<typeof buildFingerprint>; label: boolean }> = [];
for (const r of rows.slice(0, POOL)) {
  try {
    const raw = (await info({ type: "userFills", user: r.ethAddress })) as Array<Record<string, unknown>>;
    const fills = raw.map((f) => ({ coin: String(f.coin), dir: String(f.dir ?? ""), sz: Number(f.sz), px: Number(f.px), closedPnl: Number(f.closedPnl ?? 0), time: Number(f.time) } as Fill));
    if (fills.length < 30) continue;                                  // need a meaningful fingerprint
    sample.push({ addr: r.ethAddress, fp: buildFingerprint(fills), label: isVerifiedProfitable(realizedStats(fills as unknown as SmFill[])) });
    if (sample.length >= N) break;
    await sleep(60);
  } catch { /* skip */ }
}
const truths = sample.map((s) => s.label);
const nWin = truths.filter(Boolean).length;
console.log(`  ${sample.length} wallets · ground truth: ${nWin} genuine winners / ${sample.length - nWin} fakes\n`);
if (sample.length < 8 || nWin === 0 || nWin === sample.length) { console.log("  degenerate sample (need a class mix) — re-run.\n"); process.exit(0); }

// 2) run each predictor, score accuracy + permutation p
type Method = { name: string; llm: boolean; predict: (fp: unknown) => Promise<boolean> | boolean };
const methods: Method[] = [
  { name: "deterministic", llm: false, predict: (fp) => deterministicWinnerGuess(fp as any) },
  { name: "llm:single", llm: true, predict: single },
  { name: "llm:cot", llm: true, predict: cot },
  { name: "llm:ensemble@5", llm: true, predict: ensemble },
];
console.log(`  ${"method".padEnd(16)} ${"accuracy".padEnd(10)} ${"perm-p".padEnd(9)} ${"calls".padEnd(6)} verdict`);
const results: Array<{ name: string; acc: number; p: number }> = [];
for (const m of methods) {
  const before = CALLS;
  const preds: boolean[] = [];
  for (const s of sample) preds.push(await m.predict(s.fp));
  const acc = accuracy(preds, truths), p = permutationPValue(preds, truths, 5000);
  results.push({ name: m.name, acc, p });
  const verdict = p < 0.05 ? "✓ beats chance" : "✗ not significant";
  console.log(`  ${m.name.padEnd(16)} ${`${(acc * 100).toFixed(0)}%`.padEnd(10)} ${p.toFixed(3).padEnd(9)} ${String(CALLS - before).padEnd(6)} ${verdict}`);
}
const best = results.filter((r) => r.p < 0.05).sort((a, b) => a.p - b.p || b.acc - a.acc)[0];
console.log(`\n  base rate (always guess majority): ${(Math.max(nWin, sample.length - nWin) / sample.length * 100).toFixed(0)}%`);
console.log(best ? `  WINNER: ${best.name} — ${(best.acc * 100).toFixed(0)}% acc, p=${best.p.toFixed(3)} (real signal: the fingerprint DOES carry profitability info)` : `  NO method beats chance (perm-p≥0.05) — profitability is NOT readable from the behavioral fingerprint alone; you must check realized PnL. (This is the verification lesson, quantified.)`);
console.log("");
