// Client factories for dYdX v4 — IndexerClient, CompositeClient, FaucetClient.
import type {
  CompositeClient,
  FaucetClient,
  IndexerClient,
  SocketClient,
} from "@dydxprotocol/v4-client-js";
import type { ErrorEvent, MessageEvent } from "ws";
import { networkFor, type DydxNet, FAUCET_TESTNET_URL } from "./network";
import { sdk } from "./_sdk";

export function makeIndexerClient(net: DydxNet): IndexerClient {
  return new sdk.IndexerClient(networkFor(net).indexerConfig);
}

export async function makeCompositeClient(net: DydxNet): Promise<CompositeClient> {
  return sdk.CompositeClient.connect(networkFor(net));
}

/** Testnet-only — faucet doesn't exist for mainnet. */
export function makeFaucetClient(): FaucetClient {
  return new sdk.FaucetClient(FAUCET_TESTNET_URL);
}

export type SocketHandlers = {
  onOpen?: () => void;
  onClose?: () => void;
  onMessage: (event: MessageEvent) => void;
  onError?: (event: ErrorEvent) => void;
};

export function makeSocketClient(net: DydxNet, h: SocketHandlers): SocketClient {
  return new sdk.SocketClient(
    networkFor(net).indexerConfig,
    h.onOpen ?? (() => {}),
    h.onClose ?? (() => {}),
    h.onMessage,
    h.onError ?? (() => {}),
  );
}
