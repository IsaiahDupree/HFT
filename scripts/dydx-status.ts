/**
 * One-shot health summary for a dYdX wallet: address, subaccount equity,
 * positions, open orders, recent fills.
 *
 *   npm run dydx:status
 *   npm run dydx:status -- --mainnet --subaccount 0
 */
import "./_env";
import { loadWallet, makeIndexerClient, resolveNet } from "../src/lib/hft/dydx";

function argValue(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

(async () => {
  const net = resolveNet();
  const subaccountNumber = Number(argValue("subaccount", "0"));

  const { address } = await loadWallet(net, subaccountNumber);
  const indexer = makeIndexerClient(net);

  console.log(`dYdX status • net=${net} • address=${address} • subaccount=${subaccountNumber}\n`);

  const tasks = await Promise.allSettled([
    indexer.account.getSubaccount(address, subaccountNumber),
    indexer.account.getSubaccountPerpetualPositions(address, subaccountNumber, "OPEN" as any),
    indexer.account.getSubaccountOrders(address, subaccountNumber),
    indexer.account.getSubaccountFills(address, subaccountNumber),
  ]);

  const [sub, positions, orders, fills] = tasks.map((t) => t.status === "fulfilled" ? t.value : { _error: (t.reason as Error).message });

  const equity = Number((sub as any)?.subaccount?.equity ?? "0");
  const freeCollateral = Number((sub as any)?.subaccount?.freeCollateral ?? "0");
  console.log(`equity         $${equity}`);
  console.log(`freeCollateral $${freeCollateral}`);

  const posArr = (positions as any)?.positions ?? [];
  console.log(`\nopen positions: ${posArr.length}`);
  for (const p of posArr.slice(0, 10)) {
    console.log(`  ${p.market.padEnd(10)} ${p.side.padEnd(5)} size=${p.size} entry=${p.entryPrice} unrealizedPnl=${p.unrealizedPnl}`);
  }

  const orderArr = Array.isArray(orders) ? orders : ((orders as any)?.orders ?? []);
  const openOrders = orderArr.filter((o: any) => o.status === "OPEN" || o.status === "BEST_EFFORT_OPENED");
  console.log(`\nopen orders: ${openOrders.length}/${orderArr.length}`);
  for (const o of openOrders.slice(0, 10)) {
    console.log(`  ${o.ticker.padEnd(10)} ${o.side.padEnd(5)} ${o.size}@${o.price} ${o.timeInForce} status=${o.status} clientId=${o.clientId}`);
  }

  const fillArr = (fills as any)?.fills ?? [];
  console.log(`\nrecent fills: ${fillArr.length}`);
  for (const f of fillArr.slice(0, 5)) {
    console.log(`  ${f.market.padEnd(10)} ${f.side.padEnd(5)} ${f.size}@${f.price} fee=${f.fee} t=${f.createdAt}`);
  }
})();
