/**
 * train-meta-label — fit the meta-labeler P(win | gate_scores, regime) on the live
 * (strategy × regime → won) ledger, report the interpretable weights + a
 * train/holdout accuracy + a calibration table. The calibrated P(win) is what
 * replaces the hand-coded signal-agreement score and drives the size_multiplier.
 *
 *   npm run train:metalabel [-- --days 60 --strategy poly_fade_spike]
 */
import "./_env.ts";
import { loadLabeledDecisions } from "../src/lib/decision/calibration-loader.ts";
import { trainMetaLabel, metaLabelProb } from "../src/lib/decision/meta-label.ts";

const arg = (name: string): string | undefined => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const days = Number(arg("--days") ?? 90);
const since = new Date(Date.now() - days * 86_400_000).toISOString();
const rows = loadLabeledDecisions({ sinceTs: since, strategyKind: arg("--strategy"), limit: 10_000 });
const labeled = rows.filter((r) => r.gateScores);

console.log(`\ntrain-meta-label — P(win | gate_scores, regime, strategy) · last ${days}d\n`);
console.log(`  labeled decisions: ${rows.length} (${labeled.length} with gate features)`);
if (labeled.length < 12) {
  console.log(`  too thin to train (need ≥12) — the ledger accrues as the live loop journals shadow-gated decisions.\n`);
  process.exit(0);
}

// chronological holdout (loader returns ts DESC → reverse to oldest-first)
const chron = [...labeled].reverse();
const split = Math.floor(chron.length * 0.7);
const train = chron.slice(0, split), test = chron.slice(split);
const m = trainMetaLabel(train, { iters: 1200 });

console.log(`\n  learned weights (sign ⇒ effect on P(win); features the model leans on):`);
m.featureNames.map((name, j) => ({ name, w: m.weights[j] })).filter((f) => Math.abs(f.w) > 0.05).sort((a, b) => Math.abs(b.w) - Math.abs(a.w))
  .forEach((f) => console.log(`    ${f.name.padEnd(28)} ${f.w >= 0 ? "+" : ""}${f.w.toFixed(2)}`));

const acc = (set: typeof train) => set.length ? set.filter((r) => (metaLabelProb(r, m) >= 0.5) === r.won).length / set.length : 0;
console.log(`\n  accuracy: train ${(acc(train) * 100).toFixed(0)}% (n=${train.length})  ·  HOLDOUT ${(acc(test) * 100).toFixed(0)}% (n=${test.length})`);

const buckets = new Map<number, { n: number; wins: number; psum: number }>();
for (const r of chron) { const p = metaLabelProb(r, m); const b = Math.round(p * 4) / 4; const e = buckets.get(b) ?? { n: 0, wins: 0, psum: 0 }; e.n++; e.wins += r.won ? 1 : 0; e.psum += p; buckets.set(b, e); }
console.log(`  calibration (predicted P → actual win-rate):`);
for (const [, e] of [...buckets].sort((a, b) => a[0] - b[0])) console.log(`    ~${(e.psum / e.n).toFixed(2)} → ${(e.wins / e.n * 100).toFixed(0)}% actual (n=${e.n})`);
console.log(`\n  → calibrated P(win) replaces the hand-coded signal-agreement score + drives the Kelly size_multiplier.`);
console.log(`  HOLDOUT is the honest read; thin data ⇒ noisy. Sharpens as the loop journals more decisions.\n`);
