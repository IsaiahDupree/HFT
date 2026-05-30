/**
 * /deposit — "Where do I send USDC to fund my Polymarket account?"
 *
 * Defaults to the Polymarket proxy from POLYMARKET_FUNDER_ADDRESS in .env.local.
 * The page is the destination view: it shows YOUR proxy's live Polygon
 * balance + a QR code your wallet (Coinbase Base App, MetaMask, Rabby, etc.)
 * can scan to send USDC there.
 *
 * Override via ?eoa=0x… to look up any other address.
 */
import { DepositQrClient } from "./Client";

export const dynamic = "force-dynamic";

export default async function DepositPage(props: { searchParams: Promise<{ eoa?: string; amount?: string }> }) {
  const sp = await props.searchParams;
  // Default destination = the Polymarket proxy we've configured. The URL
  // can override, but the common case is "fund my own account, just show me
  // the address".
  const envFunder = process.env.POLYMARKET_FUNDER_ADDRESS ?? "";
  const initialEoa = sp.eoa ?? envFunder;
  const initialAmount = sp.amount ?? "";
  const usingEnv = !sp.eoa && envFunder.length > 0;

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-semibold">Send USDC to your Polymarket account</h1>
        <p className="text-zinc-400 text-sm mt-1">
          The QR code below is your <strong>Polymarket proxy address on Polygon</strong>.
          Scan it from your Coinbase Base App / MetaMask / Rabby / any Polygon wallet to send USDC there.
          The page also live-reads the proxy's balance so you can watch funds arrive.
        </p>
        {usingEnv && (
          <p className="text-[10px] text-zinc-500 mt-2 font-mono">
            destination = POLYMARKET_FUNDER_ADDRESS from .env.local ({envFunder.slice(0, 6)}…{envFunder.slice(-4)})
          </p>
        )}
      </div>

      <div className="card border-accent-amber/30 bg-accent-amber/5">
        <h2 className="card-title text-accent-amber">Before you scan</h2>
        <ul className="text-xs text-zinc-300 space-y-1 mt-2 list-disc list-inside">
          <li>The recipient shown <strong>is your Polymarket proxy</strong> — funds sent here become your Polymarket balance once the proxy is deployed (first trade auto-deploys).</li>
          <li>Network MUST be <strong>Polygon</strong>. Coinbase Base App's Send screen has a network selector — verify it says "Polygon" not "Base" or "Ethereum" before you confirm.</li>
          <li>Polymarket recognizes <strong>USDC.e</strong> (bridged, contract <code>0x2791Bca…84174</code>) on Polygon. Native USDC works on many newer markets too; the page below detects which kind you have and offers a one-click swap if needed.</li>
          <li>Start small. Send $20-50 first to verify the route, then add more.</li>
          <li>localhost is just where this UI runs on your laptop — it's NOT a wallet, do not send crypto to "localhost" or to your laptop's IP.</li>
        </ul>
      </div>

      <DepositQrClient initialEoa={initialEoa} initialAmount={initialAmount} />

      <div className="card">
        <h2 className="card-title">After USDC lands</h2>
        <ol className="text-xs text-zinc-300 space-y-1 mt-2 list-decimal list-inside">
          <li>Refresh this page. The USDC.e (or native USDC) tile flips green.</li>
          <li>If you sent native USDC, click the "Swap native USDC → USDC.e" button (Uniswap, ~$0.05 fee).</li>
          <li>Once you see USDC.e ≥ $5 in your proxy, set <code>ALLOW_TRADE=1</code> in <code>.env.local</code>.</li>
          <li>Restart the dev server (so the env var loads).</li>
          <li>Next <code>npm run arena:tick</code> fires your first real Polymarket order through the live capsule binding.</li>
        </ol>
      </div>
    </div>
  );
}
