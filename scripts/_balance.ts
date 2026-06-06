/** temp — read the funder's on-chain USDC balances (native + bridged) on Polygon. Read-only. */
import "./_env.ts";

const f = (process.env.POLYMARKET_FUNDER_ADDRESS || "").toLowerCase();
const TOKENS: Record<string, string> = {
  "USDC.e (bridged)": "0x2791bca1f2de4661ed88a30c99a7a9449aa84174",
  "USDC (native)": "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359",
};

(async () => {
  console.log("funder:", f);
  for (const [name, addr] of Object.entries(TOKENS)) {
    const data = "0x70a08231" + "0".repeat(24) + f.slice(2);
    try {
      const res: any = await (await fetch("https://polygon-rpc.com", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: addr, data }, "latest"] }),
      })).json();
      const raw = res?.result;
      const bal = raw && raw !== "0x" ? parseInt(raw, 16) / 1e6 : 0;
      console.log(`  ${name}: ${bal.toFixed(4)} USDC   (raw=${String(raw).slice(0, 20)})${res?.error ? " ERR " + JSON.stringify(res.error).slice(0, 80) : ""}`);
    } catch (e: any) {
      console.log(`  ${name}: fetch error ${String(e).slice(0, 80)}`);
    }
  }
})();
