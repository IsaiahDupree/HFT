/**
 * Request testnet USDC + native tokens for your testnet subaccount.
 *
 * Reads DYDX_TESTNET_MNEMONIC from .env.local (set with `npm run dydx:wallet-init`).
 *
 *   npm run dydx:faucet                  # default subaccount 0, $2000 USDC + native gas
 *   npm run dydx:faucet -- --amount 5000
 *   npm run dydx:faucet -- --subaccount 1
 *   npm run dydx:faucet -- --no-native   # skip the native-gas drip
 */
import "./_env";
import { loadWallet, makeFaucetClient } from "../src/lib/hft/dydx";

function argValue(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

(async () => {
  const subaccountNumber = Number(argValue("subaccount", "0"));
  const amount = Number(argValue("amount", "2000"));
  const skipNative = process.argv.includes("--no-native");

  const { address } = await loadWallet("testnet", subaccountNumber);
  const faucet = makeFaucetClient();

  console.log(`Faucet request • address=${address} • subaccount=${subaccountNumber} • amount=$${amount}`);

  try {
    const r = await faucet.fill(address, subaccountNumber, amount);
    console.log(`[usdc] http=${r.status}`);
  } catch (e) {
    console.error(`[usdc] failed:`, (e as Error).message);
  }

  if (!skipNative) {
    try {
      const r = await faucet.fillNative(address);
      console.log(`[native] http=${r.status}`);
    } catch (e) {
      console.error(`[native] failed:`, (e as Error).message);
    }
  }

  console.log(`\nCheck balance with: npm run dydx:status`);
})();
