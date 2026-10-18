// Network selection for dYdX v4 client. Defaults to testnet (free, faucet
// available); mainnet selected with --mainnet / env DYDX_NETWORK=mainnet.
import type { Network } from "@dydxprotocol/v4-client-js";
import { sdk } from "./_sdk";

export type DydxNet = "testnet" | "mainnet";

export function resolveNet(argv: string[] = process.argv): DydxNet {
  if (argv.includes("--mainnet")) return "mainnet";
  if (argv.includes("--testnet")) return "testnet";
  const env = (process.env.DYDX_NETWORK ?? "").toLowerCase();
  if (env === "mainnet") return "mainnet";
  return "testnet";
}

export function networkFor(net: DydxNet): Network {
  return net === "mainnet" ? sdk.Network.mainnet() : sdk.Network.testnet();
}

export const FAUCET_TESTNET_URL = "https://faucet.v4testnet.dydx.exchange";
