// Single bridge to @dydxprotocol/v4-client-js.
//
// The SDK's ESM build (build/esm/) ships internal imports without `.js`
// extensions, which is illegal under Node ESM resolution. The CJS build is
// fine, but Node's ESM-from-CJS interop misses a few getter-defined exports
// (notably LocalWallet, which uses `__importDefault(...).default`). Using
// createRequire forces a plain CJS require, which exposes the full runtime
// surface — every named export resolves via the live module.exports.
import { createRequire } from "node:module";
import type * as DydxTypes from "@dydxprotocol/v4-client-js";

const req = createRequire(import.meta.url);

export const sdk = req("@dydxprotocol/v4-client-js") as typeof DydxTypes;

// Enums that live inside socket-client.ts but aren't re-exported at the top
// level of the package. We inline the string values rather than path-mounting
// the sub-module — they're stable and the SDK has reused them since 3.0.
export const IncomingMessageTypes = {
  CONNECTED: "connected",
  SUBSCRIBED: "subscribed",
  ERROR: "error",
  CHANNEL_DATA: "channel_data",
  CHANNEL_BATCH_DATA: "channel_batch_data",
  PONG: "pong",
} as const;

export const CandlesResolution = {
  ONE_MINUTE: "1MIN",
  FIVE_MINUTES: "5MINS",
  FIFTEEN_MINUTES: "15MINS",
  THIRTY_MINUTES: "30MINS",
  ONE_HOUR: "1HOUR",
  FOUR_HOURS: "4HOURS",
  ONE_DAY: "1DAY",
} as const;

export type CandlesResolution = typeof CandlesResolution[keyof typeof CandlesResolution];
