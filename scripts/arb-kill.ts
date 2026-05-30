// Emergency cancel-all for arb runner positions. Always allowed.
import "./_env.ts";
import { killSwitch } from "../src/lib/polymarket/execute.ts";

const r = await killSwitch();
console.log(r);
process.exit(r.ok ? 0 : 1);
