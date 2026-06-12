import "./_env.ts";
import { getCandles, closeTsdb } from "../src/lib/db/candle-store";
for (const p of ["BTCUSDT","ETHUSDT","SOLUSDT"]) {
  const c = await getCandles(p,"ONE_DAY");
  if (c.length) console.log(p, "n=",c.length, "first", new Date(c[0].start_unix*1000).toISOString().slice(0,10), "last", new Date(c.at(-1)!.start_unix*1000).toISOString().slice(0,10));
  else console.log(p,"EMPTY");
}
// USD universe overlap with funding window (2025-01-21+)
for (const p of ["BTC-USD","ETH-USD","SOL-USD","XRP-USD","DOGE-USD"]) {
  const c = (await getCandles(p,"ONE_DAY")).filter(x=>x.start_unix>=1737417600);
  console.log(p,"days in funding window:",c.length, c.length?("last "+new Date(c.at(-1)!.start_unix*1000).toISOString().slice(0,10)):"");
}
await closeTsdb();
