/**
 * Generate a fresh dYdX wallet (24-word BIP-39 mnemonic), print address + the
 * env line you should add to .env.local. Does NOT write to .env.local
 * automatically — copy/paste so it's a deliberate action.
 *
 *   npm run dydx:wallet-init                 # testnet (default)
 *   npm run dydx:wallet-init -- --mainnet
 */
import "./_env";
import { addressFromMnemonic, generateMnemonic, mnemonicEnvVar, resolveNet } from "../src/lib/hft/dydx";

(async () => {
  const net = resolveNet();
  const varName = mnemonicEnvVar(net);
  const existing = (process.env[varName] ?? "").trim();
  if (existing) {
    const address = await addressFromMnemonic(existing);
    console.log(`Already configured ${varName} in .env.local`);
    console.log(`  address: ${address}`);
    console.log(`Pass --force to generate a new one (this will print, not overwrite).`);
    if (!process.argv.includes("--force")) return;
  }

  const mnemonic = generateMnemonic();
  const address = await addressFromMnemonic(mnemonic);
  console.log(`Generated ${net} wallet:`);
  console.log(`  address : ${address}`);
  console.log(`  mnemonic: ${mnemonic}`);
  console.log("");
  console.log(`Add to .env.local:`);
  console.log(`  ${varName}="${mnemonic}"`);
  console.log("");
  console.log("⚠️  Treat this mnemonic like a password. Anyone with it controls the wallet.");
  if (net === "testnet") {
    console.log("    Testnet funds have no real value but ToS still applies.");
  }
})();
