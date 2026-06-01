/**
 * ONE-SHOT instrumented live order — the controlled execution-lag/slippage test.
 *
 * Places EXACTLY ONE single-side market order (FAK) and measures:
 *   - execution lag  : wall-time of submit→match→response (FAK is synchronous)
 *   - fill price      : avg fill (USDC/shares) from the broker response
 *   - slippage        : fill price − intended refPrice (the ask we aimed at)
 *   - shares filled / status
 *
 * SAFETY (defense in depth, all required for a REAL order):
 *   - --confirm flag AND ALLOW_TRADE=1 in THIS process's env (set inline, never
 *     in .env.local — so the loop/server stay disarmed and nothing persists).
 *   - size hard-clamped to ≤ --max (default $2).
 *   - without both gates it runs in SHADOW (submitSingleSideMarket dry-runs).
 *
 *   # shadow (no money — validates the instrument):
 *   npx tsx scripts/live-fill-test.ts --token 0x… --side BUY --ref 0.86
 *   # LIVE one order (real $2):
 *   ALLOW_TRADE=1 npx tsx scripts/live-fill-test.ts --token 0x… --side BUY --ref 0.86 --confirm
 */
import "./_env.ts";
import { submitSingleSideMarket } from "../src/lib/polymarket/execute.ts";

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

(async () => {
  const token = arg("token");
  const side = (arg("side", "BUY") || "BUY").toUpperCase() as "BUY" | "SELL";
  const ref = Number(arg("ref", "0"));
  const max = Number(arg("max", "2"));
  const size = Math.min(Number(arg("size", "2")), max);   // hard cap
  const confirm = process.argv.includes("--confirm");
  const armed = process.env.ALLOW_TRADE === "1" && confirm;

  if (!token || !(ref > 0 && ref < 1) || !(size > 0)) {
    console.error("usage: --token <id> --side BUY|SELL --ref <0..1> [--size 2] [--max 2] [--confirm]");
    process.exit(2);
  }

  console.log("════════════════════════════════════════════════════════════════");
  console.log(`  LIVE-FILL TEST — ${armed ? "🔴 ARMED (real order)" : "🟢 SHADOW (dry-run)"}`);
  console.log("════════════════════════════════════════════════════════════════");
  console.log(`  ${side} ${token.slice(0, 14)}…  $${size.toFixed(2)} @ ref ${ref.toFixed(3)}`);
  console.log(`  ALLOW_TRADE=${process.env.ALLOW_TRADE ?? "unset"}  confirm=${confirm}  cap=$${max}`);

  const t0 = Date.now();
  const verdict = await submitSingleSideMarket({
    tokenId: token, side, sizeUsd: size, refPrice: ref,
    rationale: `live-fill-test ${armed ? "ARMED" : "shadow"}`,
  });
  const lagMs = Date.now() - t0;

  console.log(`\n  verdict: ${verdict.kind}   (submit→response ${lagMs}ms)`);
  const raw: any = (verdict as any).raw;
  if (verdict.kind === "dry-run") {
    console.log(`  (shadow) reason: ${(verdict as any).reason}`);
  } else if (verdict.kind === "executed") {
    // FAK response shapes vary — pull avg fill defensively.
    const making = Number(raw?.makingAmount ?? raw?.making_amount ?? NaN); // USDC spent (BUY)
    const taking = Number(raw?.takingAmount ?? raw?.taking_amount ?? NaN); // shares got (BUY)
    const fillPrice = Number.isFinite(making) && Number.isFinite(taking) && taking > 0
      ? making / taking
      : Number(raw?.price ?? NaN);
    console.log(`  order id  : ${(verdict as any).brokerOrderId ?? "?"}`);
    if (Number.isFinite(fillPrice)) {
      console.log(`  fill price: ${fillPrice.toFixed(4)}   slippage vs ref: ${((fillPrice - ref) * 100).toFixed(2)}¢`);
      if (Number.isFinite(taking)) console.log(`  shares    : ${taking.toFixed(2)}  (paid ~$${making.toFixed(2)})`);
    } else {
      console.log("  fill price: (not in response — raw dumped below)");
    }
    console.log(`  raw       : ${JSON.stringify(raw).slice(0, 400)}`);
  } else {
    console.log(`  reason: ${(verdict as any).reason}`);
  }
  console.log(`\n  EXECUTION LAG = ${lagMs}ms (FAK is synchronous → this is submit+match+ack).`);
  console.log(`  ${armed ? "Real order placed — review the fill above, then leave ALLOW_TRADE unset (already disarmed)." : "Shadow only — no money. Re-run with ALLOW_TRADE=1 … --confirm for a real $2 order."}`);
  process.exit(0);
})();
