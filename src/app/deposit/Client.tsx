"use client";

/**
 * Client side of the /deposit page.
 *
 * Renders the EOA input + amount input + fetches /api/polymarket/deposit,
 * then renders QR code(s) via the `qrcode` package as inline SVG.
 *
 * Why client-only QR rendering: SSR can't easily produce the QR matrix
 * synchronously without bundling the qrcode dep into the server build, and
 * we want users to be able to copy/paste the URI as well — easier when the
 * URI lives in client state and the user can tweak amount/address live.
 */
import { useEffect, useState } from "react";
import QRCode from "qrcode";

type DepositResponse = {
  eoa: string;
  amount_usdc: number;
  token: { address: string; symbol: string; decimals: number; network: string; chain_id: number };
  eoa_mode: {
    signature_type: 0;
    label: string;
    address: string;
    uris: { eip681: string; address_only: string };
  };
  existing_proxy: {
    signature_type: number;
    label: string;
    address: string;
    uris: { eip681: string; address_only: string } | null;
    profile: { created_at?: string; pseudonym?: string; name?: string } | null;
  } | null;
  balances: { address: string; matic: number; weth: number; usdc_e: number; usdc_native: number; error?: string };
  multi_chain_balances: Array<{
    chain: string; chain_id: number; native_symbol: string;
    native: number; usdc: number; weth: number; usdc_e?: number; error?: string;
  }>;
  swap: {
    uniswap: { eth_to_usdce: string; matic_to_usdce: string; weth_to_usdce: string; native_usdc_to_usdce: string };
    suggestion: { state: string; message: string };
  };
  bridges: {
    detected_chain: string;
    detected_native_amount: number;
    detected_usdc_amount: number;
    across: string;
    squid: string;
    polygon_portal: string;
  } | null;
  tokens: { usdc_e: string; usdc_native: string; weth: string };
  errors: string[];
};

export function DepositQrClient({ initialEoa, initialAmount }: { initialEoa: string; initialAmount: string }) {
  const [eoa, setEoa] = useState(initialEoa);
  const [amount, setAmount] = useState(initialAmount);
  const [data, setData] = useState<DepositResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function lookup() {
    setBusy(true);
    setErr(null);
    setData(null);
    try {
      const url = `/api/polymarket/deposit?eoa=${encodeURIComponent(eoa)}` +
        (amount ? `&amount=${encodeURIComponent(amount)}` : "");
      const r = await fetch(url);
      const j = (await r.json()) as DepositResponse & { error?: string };
      if (!r.ok) {
        setErr(j.error ?? `HTTP ${r.status}`);
      } else {
        setData(j);
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // Auto-lookup if the EOA was passed via URL.
  useEffect(() => {
    if (initialEoa) lookup();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="space-y-4">
      <div className="card">
        <div className="grid grid-cols-[2fr_1fr_auto] gap-2 items-end">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-zinc-400">
              Destination address (your Polymarket proxy)
              <span className="text-zinc-600 ml-2">— pre-filled from POLYMARKET_FUNDER_ADDRESS; override to look up any other address</span>
            </span>
            <input
              value={eoa}
              onChange={(e) => setEoa(e.target.value.trim())}
              placeholder="0x…"
              className="bg-ink-900 border border-ink-700 rounded px-3 py-2 text-zinc-200 font-mono text-sm focus:outline-none focus:border-accent-blue/60"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-zinc-400">Amount (USDC, optional)</span>
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value.trim())}
              placeholder="e.g. 20"
              inputMode="decimal"
              className="bg-ink-900 border border-ink-700 rounded px-3 py-2 text-zinc-200 font-mono text-sm focus:outline-none focus:border-accent-blue/60"
            />
          </label>
          <button
            onClick={lookup}
            disabled={busy || !eoa}
            className="px-4 py-2 rounded bg-accent-blue/20 border border-accent-blue/40 text-accent-blue hover:bg-accent-blue/30 disabled:opacity-50"
          >
            {busy ? "Looking up…" : "Refresh"}
          </button>
        </div>
        {err && <p className="mt-3 text-xs text-accent-red">Error: {err}</p>}
      </div>

      {data && (
        <div className="space-y-4">
          {/* Balances + swap advisor. Tells the user whether they need to swap
              their current Polygon holdings to USDC.e before depositing. */}
          <BalanceCard balances={data.balances} swap={data.swap} eoa={data.eoa} />

          {/* Multi-chain view — surfaces if funds landed on wrong chain. */}
          <MultiChainTable rows={data.multi_chain_balances} />

          {/* Bridge card — only shows when the API detected funds on a non-Polygon chain. */}
          {data.bridges && <BridgeCard bridges={data.bridges} />}

          {/* Primary: where to send USDC to fund this Polymarket account. */}
          <QrCard
            kind="primary"
            title="Scan from your wallet — send USDC to this address on Polygon"
            address={data.eoa_mode.address}
            uri={data.eoa_mode.uris.eip681}
            fallbackUri={data.eoa_mode.uris.address_only}
            amount={data.amount_usdc}
            token={data.token}
            footnote="In your wallet's Send screen, verify: network = Polygon (not Base/Ethereum), token = USDC (or USDC.e), recipient matches the address above exactly."
          />

          {/* Secondary: only shown when the EOA already has a Polymarket account
              registered AND it differs from the EOA itself (Magic.link/Safe). */}
          {data.existing_proxy && data.existing_proxy.address !== data.eoa_mode.address && data.existing_proxy.uris && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-2">
                This EOA already has a separate proxy registered with Polymarket — use this if you want to continue using that existing account
              </div>
              <QrCard
                kind="secondary"
                title={data.existing_proxy.label}
                address={data.existing_proxy.address}
                uri={data.existing_proxy.uris.eip681}
                fallbackUri={data.existing_proxy.uris.address_only}
                amount={data.amount_usdc}
                token={data.token}
                footnote={data.existing_proxy.signature_type === 2
                  ? "Set POLYMARKET_SIGNATURE_TYPE=2 and POLYMARKET_FUNDER_ADDRESS = this proxy address in .env.local."
                  : "Set POLYMARKET_SIGNATURE_TYPE=1 and POLYMARKET_FUNDER_ADDRESS = this proxy address in .env.local."}
                profile={data.existing_proxy.profile}
              />
            </div>
          )}

          {data.existing_proxy && data.existing_proxy.address === data.eoa_mode.address && (
            <p className="text-xs text-zinc-500 italic">
              ✓ This EOA is already registered with Polymarket (created {data.existing_proxy.profile?.created_at?.slice(0, 10) ?? "—"}) in EOA-mode.
              You're ready to deposit and trade.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function MultiChainTable({ rows }: { rows: DepositResponse["multi_chain_balances"] }) {
  // Order rows by total dollar-ish value so the chain with funds rises to the top.
  const sorted = [...rows].sort((a, b) => {
    const vA = (a.native ?? 0) + (a.usdc ?? 0) + (a.weth ?? 0) + (a.usdc_e ?? 0);
    const vB = (b.native ?? 0) + (b.usdc ?? 0) + (b.weth ?? 0) + (b.usdc_e ?? 0);
    return vB - vA;
  });
  return (
    <div className="card">
      <h3 className="card-title">Multi-chain balance check</h3>
      <p className="text-[10px] text-zinc-500 mb-2">Reads live from each chain's public RPC. Helps catch the "wrong network" mistake.</p>
      <table className="list">
        <thead>
          <tr>
            <th>Chain</th>
            <th className="text-right">Native</th>
            <th className="text-right">USDC</th>
            <th className="text-right">WETH</th>
            <th className="text-right">USDC.e</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => {
            const hasFunds = (r.native ?? 0) > 0.0001 || (r.usdc ?? 0) > 0.01 || (r.weth ?? 0) > 0.0001 || (r.usdc_e ?? 0) > 0.01;
            const isPolygon = r.chain === "polygon";
            const status = r.error ? <span className="text-accent-red">RPC error</span>
              : !hasFunds ? <span className="text-zinc-600">empty</span>
              : isPolygon ? <span className="text-accent-green">✓ Polymarket chain</span>
              : <span className="text-accent-amber">⚠ wrong chain — bridge to Polygon</span>;
            return (
              <tr key={r.chain}>
                <td className="capitalize">{r.chain}</td>
                <td className="text-right tabular-nums">{formatNum(r.native)} {r.native_symbol}</td>
                <td className="text-right tabular-nums">{formatNum(r.usdc)}</td>
                <td className="text-right tabular-nums">{formatNum(r.weth)}</td>
                <td className="text-right tabular-nums">{r.usdc_e !== undefined ? formatNum(r.usdc_e) : "—"}</td>
                <td className="text-xs">{status}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function formatNum(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return "—";
  if (n === 0) return "0";
  if (n < 0.0001) return n.toExponential(2);
  if (n < 1) return n.toFixed(4);
  return n.toFixed(2);
}

function BridgeCard({ bridges }: { bridges: NonNullable<DepositResponse["bridges"]> }) {
  return (
    <div className="card border-accent-amber/40 bg-accent-amber/5">
      <h3 className="card-title text-accent-amber">⚠ Funds detected on {bridges.detected_chain.toUpperCase()} — bridge to Polygon first</h3>
      <p className="text-xs text-zinc-300 mt-2">
        Detected ~{bridges.detected_native_amount.toFixed(4)} native + {bridges.detected_usdc_amount.toFixed(2)} USDC on{" "}
        <strong>{bridges.detected_chain}</strong>. Polymarket only reads Polygon, so these funds need to be bridged + swapped to USDC.e.
      </p>

      <AutoBridgeButton />

      <p className="text-[10px] text-zinc-500 mt-4 mb-1">Or use an external bridge (your key never leaves your wallet):</p>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-2 text-xs">
        <a href={bridges.across} target="_blank" rel="noopener noreferrer" className="block px-3 py-2 rounded border border-ink-700 hover:border-accent-blue/40 hover:bg-accent-blue/5">
          <div className="font-semibold text-zinc-200">Across ↗</div>
          <div className="text-[10px] text-zinc-500">Fastest (~2-5 min) · low fees · sign in your own wallet</div>
        </a>
        <a href={bridges.squid} target="_blank" rel="noopener noreferrer" className="block px-3 py-2 rounded border border-ink-700 hover:border-accent-blue/40 hover:bg-accent-blue/5">
          <div className="font-semibold text-zinc-200">Squid Router ↗</div>
          <div className="text-[10px] text-zinc-500">Aggregator · bridge+swap combined</div>
        </a>
        <a href={bridges.polygon_portal} target="_blank" rel="noopener noreferrer" className="block px-3 py-2 rounded border border-ink-700 hover:border-accent-blue/40 hover:bg-accent-blue/5">
          <div className="font-semibold text-zinc-200">Polygon Portal ↗</div>
          <div className="text-[10px] text-zinc-500">Official PoS bridge (slowest · most trusted)</div>
        </a>
      </div>
    </div>
  );
}

/**
 * AutoBridge — server-side automated bridge using LI.FI.
 *
 * The button calls /api/polymarket/bridge which signs a single mainnet tx
 * with the user's POLYMARKET_PRIVATE_KEY (from .env.local) and polls
 * Polygon for arrival. Two-phase: first click = DRY_RUN, second click =
 * LIVE (gated by ALLOW_BRIDGE=1 in .env.local on the server).
 */
function AutoBridgeButton() {
  const [phase, setPhase] = useState<"idle" | "dry-running" | "ready-to-confirm" | "running" | "done" | "error">("idle");
  const [result, setResult] = useState<{
    kind?: string; reason?: string; code?: string;
    plan?: { bridge_eth: number; quote: { toAmount: string; toolName: string; executionDurationSec: number; feeCostsUsd: number; gasCostsUsd: number; toAmountUsd: number } };
    tx_hash?: string; delta_usdce?: number; note?: string;
  } | null>(null);

  async function call(live: boolean) {
    setPhase(live ? "running" : "dry-running");
    setResult(null);
    try {
      const r = await fetch("/api/polymarket/bridge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ live }),
      });
      const j = await r.json();
      setResult(j);
      if (j.kind === "executed") setPhase("done");
      else if (j.kind === "rejected") setPhase("error");
      else if (j.kind === "dry-run") setPhase("ready-to-confirm");
      else if (j.kind === "submitted-pending") setPhase("done");
      else setPhase("error");
    } catch (e) {
      setResult({ reason: (e as Error).message });
      setPhase("error");
    }
  }

  const expectedUsdcE = result?.plan ? Number(result.plan.quote.toAmount) / 1e6 : 0;

  return (
    <div className="mt-3 p-3 rounded border border-accent-green/40 bg-accent-green/5">
      <div className="flex items-baseline justify-between mb-2">
        <h4 className="text-sm font-semibold text-accent-green">⚡ Auto-bridge (server-side, uses .env.local key)</h4>
        <span className="text-[10px] text-zinc-500">LI.FI route · leaves 0.005 ETH for gas · 24h rate-limited</span>
      </div>

      {phase === "idle" && (
        <>
          <p className="text-[10px] text-zinc-400 mb-2">
            Server fetches a quote, prints the plan, then waits for your confirmation before signing.
            Requires <code>POLYMARKET_PRIVATE_KEY</code> in .env.local. Refuses if amount &gt; 0.5 ETH or another bridge happened in the last 24h.
          </p>
          <button
            onClick={() => call(false)}
            className="px-3 py-1.5 text-xs rounded bg-accent-green/20 border border-accent-green/40 text-accent-green hover:bg-accent-green/30"
          >
            Preview bridge plan (DRY_RUN)
          </button>
        </>
      )}

      {phase === "dry-running" && <p className="text-xs text-zinc-400">Fetching quote + plan…</p>}

      {phase === "ready-to-confirm" && result?.plan && (
        <>
          <div className="text-xs text-zinc-300 space-y-1 mb-2">
            <div>Bridge <strong>{result.plan.bridge_eth.toFixed(6)} ETH</strong> (mainnet) → <strong>{expectedUsdcE.toFixed(2)} USDC.e</strong> (Polygon)</div>
            <div className="text-zinc-500">
              Tool: {result.plan.quote.toolName} · ETA {result.plan.quote.executionDurationSec}s ·
              fees ${result.plan.quote.feeCostsUsd.toFixed(2)} · gas ${result.plan.quote.gasCostsUsd.toFixed(2)} ·
              expected output ~${result.plan.quote.toAmountUsd.toFixed(2)}
            </div>
            {result.note && <div className="text-accent-amber">{result.note}</div>}
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => call(true)}
              className="px-3 py-1.5 text-xs rounded bg-accent-amber/20 border border-accent-amber/40 text-accent-amber hover:bg-accent-amber/30"
            >
              🔥 Sign + send LIVE (requires ALLOW_BRIDGE=1 on server)
            </button>
            <button
              onClick={() => { setPhase("idle"); setResult(null); }}
              className="px-3 py-1.5 text-xs rounded bg-ink-800 border border-ink-700 text-zinc-400 hover:bg-ink-700"
            >
              Cancel
            </button>
          </div>
        </>
      )}

      {phase === "running" && (
        <p className="text-xs text-zinc-400">
          Signing + broadcasting on mainnet, then polling Polygon for the USDC.e arrival.
          This page may sit for up to ~5 minutes — do not close it. Tail of progress in evolution_log.
        </p>
      )}

      {phase === "done" && result && (
        <div className="text-xs text-zinc-200 space-y-1">
          <div className="text-accent-green font-semibold">
            {result.kind === "executed" ? "✓ Bridge complete" : "✓ Bridge submitted (Polygon arrival still pending)"}
          </div>
          {result.tx_hash && (
            <div>Mainnet tx: <a className="text-accent-blue hover:underline" target="_blank" rel="noopener" href={`https://etherscan.io/tx/${result.tx_hash}`}>{result.tx_hash.slice(0, 14)}…</a></div>
          )}
          {result.delta_usdce && <div>+{result.delta_usdce.toFixed(2)} USDC.e arrived on Polygon</div>}
          <button onClick={() => location.reload()} className="mt-2 px-3 py-1.5 text-xs rounded bg-accent-blue/20 border border-accent-blue/40 text-accent-blue hover:bg-accent-blue/30">
            Refresh balances
          </button>
        </div>
      )}

      {phase === "error" && (
        <div className="text-xs text-accent-red space-y-1">
          <div>REJECTED [{result?.code ?? "unknown"}]: {result?.reason ?? "no reason given"}</div>
          <button onClick={() => { setPhase("idle"); setResult(null); }} className="mt-2 px-3 py-1.5 text-xs rounded bg-ink-800 border border-ink-700 text-zinc-400 hover:bg-ink-700">
            Reset
          </button>
        </div>
      )}
    </div>
  );
}

function BalanceCard({
  balances, swap, eoa,
}: {
  balances: DepositResponse["balances"];
  swap: DepositResponse["swap"];
  eoa: string;
}) {
  const suggestionTone =
    swap.suggestion.state === "ready" ? "border-accent-green/40 bg-accent-green/5 text-accent-green"
    : swap.suggestion.state === "empty" ? "border-accent-amber/40 bg-accent-amber/5 text-accent-amber"
    : "border-accent-blue/40 bg-accent-blue/5 text-accent-blue";

  const has = (n: number) => Number.isFinite(n) && n > 0;
  return (
    <div className="card">
      <div className="flex items-baseline justify-between">
        <h3 className="card-title m-0">Current Polygon balances</h3>
        <span className="text-[10px] text-zinc-500">read live from on-chain · refresh by clicking Generate QR</span>
      </div>
      {balances.error ? (
        <p className="mt-2 text-xs text-accent-red">Could not read balances: {balances.error}</p>
      ) : (
        <>
          <div className="grid grid-cols-4 gap-3 mt-3">
            <BalanceTile label="MATIC" value={balances.matic} unit="MATIC" hint="for gas" />
            <BalanceTile label="USDC.e" value={balances.usdc_e} unit="USDC.e" hint="✓ Polymarket-ready" emphasize={has(balances.usdc_e)} />
            <BalanceTile label="Native USDC" value={balances.usdc_native} unit="USDC" hint="needs swap → USDC.e" warn={has(balances.usdc_native) && !has(balances.usdc_e)} />
            <BalanceTile label="WETH" value={balances.weth} unit="WETH" hint="needs swap → USDC.e" warn={has(balances.weth) && !has(balances.usdc_e)} />
          </div>
          <div className={`mt-3 px-3 py-2 rounded border text-xs ${suggestionTone}`}>{swap.suggestion.message}</div>

          {/* Swap helpers — always shown, since the user might want any direction. */}
          <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-2 text-xs">
            <SwapLink href={swap.uniswap.eth_to_usdce} label="Swap ETH → USDC.e" sub="Uniswap on Polygon · ETH is bridged from mainnet automatically" />
            <SwapLink href={swap.uniswap.matic_to_usdce} label="Swap MATIC → USDC.e" sub="Uniswap · keep ~0.5 MATIC for gas" />
            <SwapLink href={swap.uniswap.weth_to_usdce} label="Swap WETH → USDC.e" sub="Uniswap · if you've already bridged ETH to Polygon" />
            <SwapLink href={swap.uniswap.native_usdc_to_usdce} label="Swap native USDC → USDC.e" sub="Uniswap · tiny slippage" />
          </div>
          <p className="mt-3 text-[10px] text-zinc-500 italic">
            Coinbase Base App also has a built-in swap: in the app, open the asset → tap Convert/Swap → choose USDC.e on Polygon as the target.
            Make sure the network says <strong>Polygon</strong>, not Base.
          </p>
        </>
      )}
    </div>
  );
}

function BalanceTile({
  label, value, unit, hint, emphasize, warn,
}: {
  label: string; value: number; unit: string; hint: string;
  emphasize?: boolean; warn?: boolean;
}) {
  const display = Number.isFinite(value)
    ? value > 0
      ? value < 0.01 ? value.toFixed(6) : value.toFixed(2)
      : "0"
    : "—";
  const border = emphasize ? "border-accent-green/40 bg-accent-green/5"
    : warn ? "border-accent-amber/40 bg-accent-amber/5"
    : "border-ink-700";
  const numColor = emphasize ? "text-accent-green" : warn ? "text-accent-amber" : "text-zinc-200";
  return (
    <div className={`rounded border p-2 ${border}`}>
      <div className="text-[10px] text-zinc-500">{label}</div>
      <div className={`text-lg font-semibold tabular-nums ${numColor}`}>{display}</div>
      <div className="text-[10px] text-zinc-500">{unit} · {hint}</div>
    </div>
  );
}

function SwapLink({ href, label, sub }: { href: string; label: string; sub: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="block px-3 py-2 rounded border border-ink-700 hover:border-accent-blue/40 hover:bg-accent-blue/5"
    >
      <div className="font-semibold text-zinc-200">{label} ↗</div>
      <div className="text-[10px] text-zinc-500">{sub}</div>
    </a>
  );
}

function QrCard({
  kind, title, address, uri, fallbackUri, amount, token, footnote, profile,
}: {
  kind: "primary" | "secondary";
  title: string;
  address: string;
  uri: string;
  fallbackUri: string;
  amount: number;
  token: { address: string; symbol: string; network: string; chain_id: number };
  footnote: string;
  profile?: { created_at?: string; pseudonym?: string; name?: string } | null;
}) {
  const [svg, setSvg] = useState<string | null>(null);
  const [svgFallback, setSvgFallback] = useState<string | null>(null);
  const [showFallback, setShowFallback] = useState(false);
  const [copied, setCopied] = useState<"address" | "uri" | null>(null);

  useEffect(() => {
    QRCode.toString(uri, { type: "svg", margin: 1, width: 320, errorCorrectionLevel: "M" })
      .then(setSvg).catch(() => setSvg(null));
    QRCode.toString(fallbackUri, { type: "svg", margin: 1, width: 320, errorCorrectionLevel: "M" })
      .then(setSvgFallback).catch(() => setSvgFallback(null));
  }, [uri, fallbackUri]);

  async function copy(text: string, what: "address" | "uri") {
    await navigator.clipboard.writeText(text);
    setCopied(what);
    setTimeout(() => setCopied(null), 1500);
  }

  const activeSvg = showFallback ? svgFallback : svg;
  const borderColor = kind === "primary" ? "border-accent-green/40 bg-accent-green/5" : "border-zinc-700 bg-ink-900/40";

  return (
    <div className={`card ${borderColor}`}>
      <h3 className={`card-title ${kind === "primary" ? "text-accent-green" : ""}`}>{title}</h3>
      <div className="mt-3 grid grid-cols-1 md:grid-cols-[auto_1fr] gap-4 items-start">
        <div className="bg-white rounded p-3 inline-block">
          {activeSvg ? (
            <div dangerouslySetInnerHTML={{ __html: activeSvg }} />
          ) : (
            <p className="text-zinc-500">Generating QR…</p>
          )}
        </div>
        <div className="space-y-3 text-xs">
          <div>
            <div className="text-zinc-500">Recipient</div>
            <div className="font-mono text-zinc-200 break-all">{address}</div>
            <button onClick={() => copy(address, "address")} className="mt-1 text-[10px] text-accent-blue hover:underline">
              {copied === "address" ? "✓ copied" : "Copy address"}
            </button>
          </div>
          <div>
            <div className="text-zinc-500">Token + network</div>
            <div className="text-zinc-200">{token.symbol} on {token.network} (chain {token.chain_id})</div>
            <div className="font-mono text-zinc-400 break-all text-[10px]">{token.address}</div>
          </div>
          {amount > 0 && (
            <div>
              <div className="text-zinc-500">Amount pre-filled</div>
              <div className="text-zinc-200">${amount.toFixed(2)} USDC</div>
            </div>
          )}
          {profile && (
            <div>
              <div className="text-zinc-500">Polymarket profile</div>
              <div className="text-zinc-200">{profile.pseudonym ?? "—"}</div>
              <div className="text-zinc-500 text-[10px]">created {profile.created_at?.slice(0, 10) ?? "—"}</div>
            </div>
          )}
          <p className="text-zinc-400 italic">{footnote}</p>
          <button
            onClick={() => setShowFallback(!showFallback)}
            className="text-[10px] text-accent-blue hover:underline"
          >
            {showFallback ? "← Use EIP-681 (token-aware) QR" : "App didn't recognize? → Use address-only QR"}
          </button>
          <details className="text-zinc-500">
            <summary className="cursor-pointer hover:text-zinc-300">Show raw URI</summary>
            <div className="mt-1 font-mono break-all bg-ink-900 p-2 rounded">{showFallback ? fallbackUri : uri}</div>
            <button onClick={() => copy(showFallback ? fallbackUri : uri, "uri")} className="mt-1 text-[10px] text-accent-blue hover:underline">
              {copied === "uri" ? "✓ copied" : "Copy URI"}
            </button>
          </details>
        </div>
      </div>
    </div>
  );
}
