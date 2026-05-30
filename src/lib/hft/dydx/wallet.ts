// Wallet helpers for dYdX v4 — generation and loading from env.
//
// Env conventions:
//   DYDX_TESTNET_MNEMONIC  — 24-word mnemonic for testnet wallet
//   DYDX_MAINNET_MNEMONIC  — 24-word mnemonic for mainnet wallet (only if you opted in)
//   DYDX_SUBACCOUNT        — integer subaccount index (default 0)
import type { LocalWallet, SubaccountInfo } from "@dydxprotocol/v4-client-js";
import { Bip39, Random } from "@cosmjs/crypto";
import { sdk } from "./_sdk";

const BECH32_PREFIX = "dydx";

export type LoadedWallet = {
  wallet: LocalWallet;
  subaccount: SubaccountInfo;
  address: string;
  subaccountNumber: number;
};

/** 24-word BIP-39 mnemonic. */
export function generateMnemonic(): string {
  // 256 bits of entropy → 24-word mnemonic, matching dYdX defaults.
  const entropy = Random.getBytes(32);
  return Bip39.encode(entropy).toString();
}

/** Derive the dydx1... address from a mnemonic without instantiating a full wallet. */
export async function addressFromMnemonic(mnemonic: string): Promise<string> {
  const w = await sdk.LocalWallet.fromMnemonic(mnemonic, BECH32_PREFIX);
  if (!w.address) throw new Error("address missing after wallet construction");
  return w.address;
}

export function mnemonicEnvVar(net: "testnet" | "mainnet"): string {
  return net === "mainnet" ? "DYDX_MAINNET_MNEMONIC" : "DYDX_TESTNET_MNEMONIC";
}

export async function loadWallet(
  net: "testnet" | "mainnet",
  subaccountNumber: number = Number(process.env.DYDX_SUBACCOUNT ?? "0"),
): Promise<LoadedWallet> {
  const varName = mnemonicEnvVar(net);
  const mnemonic = (process.env[varName] ?? "").trim();
  if (!mnemonic) {
    throw new Error(
      `Missing mnemonic. Set ${varName} in .env.local — generate one with: npm run dydx:wallet-init`,
    );
  }
  const wallet = await sdk.LocalWallet.fromMnemonic(mnemonic, BECH32_PREFIX);
  if (!wallet.address) throw new Error("address missing after wallet construction");
  const subaccount = sdk.SubaccountInfo.forLocalWallet(wallet, subaccountNumber);
  return { wallet, subaccount, address: wallet.address, subaccountNumber };
}

export { BECH32_PREFIX };
