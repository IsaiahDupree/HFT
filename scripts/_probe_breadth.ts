import "./_env.ts";
import { listProducts, getCandles, closeTsdb } from "../src/lib/db/candle-store";
const all = await listProducts("ONE_DAY");
const usdt = all.filter(p=>/USDT$/i.test(p));
const usd = all.filter(p=>/-USD$/i.test(p));
console.log("USDT products:", usdt.length, usdt.slice(0,30).join(","));
console.log("USD products:", usd.length, usd.join(","));
for (const p of ["BTC-USD","ETH-USD","SOL-USD"]) {
  const c = await getCandles(p,"ONE_DAY");
  if (c.length) console.log(p, "n=",c.length, "first", new Date(c[0].start_unix*1000).toISOString().slice(0,10), "last", new Date(c.at(-1)!.start_unix*1000).toISOString().slice(0,10));
}
await closeTsdb();
