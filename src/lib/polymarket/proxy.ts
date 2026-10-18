/**
 * Polymarket address resolution helpers.
 *
 * Background — there are three kinds of address that show up in this codebase:
 *
 *   1. Controller / signer  — the EOA that signs orders (e.g. a Magic.link
 *      email-login wallet). Doesn't hold the position; just authorizes it.
 *   2. ProxyWallet contract — the on-chain contract that custodies the user's
 *      positions and counts as `maker`/`taker` in CTF Exchange events.
 *      Deterministically derived from the controller via CREATE2 by the
 *      ProxyWallet factory.
 *   3. Safe (Gnosis) wallet — alternative custody contract for institutional /
 *      multisig users.
 *
 * Crucially: the Polymarket **Data API's `proxyWallet` field already returns
 * the on-chain ProxyWallet contract address** — not the controller. So when
 * we filter `eth_getLogs` for OrderFilled events using the value from
 * `tracked_wallets.proxy_wallet`, the filter is already correct.
 *
 * Verified on-chain (2026-05-26) for `0xb55fa1296E6ec55D0cE53d93B9237389f11764d4`:
 * its most recent Polymarket trade emits an `OrderFilled` on the CTF
 * Exchange (`0xE111180000d2663C0091e4f400237545B87B996B`) with the same
 * address as `taker` (and a counterparty as `maker`). The Data API's
 * `proxyWallet` lookup returns this exact address.
 *
 * This module exists primarily to provide a typed resolution boundary the
 * backfill script (and tests) can rely on. If/when we add Gnosis-Safe wallet
 * support, the resolver should detect that and look up the safe address via
 * the Polymarket relayer's `/relay-payload?type=SAFE` endpoint.
 */

/** Strict 0x-prefixed 40-hex-char Polygon address. */
export type OnchainAddress = `0x${string}`;

export type ResolveProxyResult = {
  /** The address to use for on-chain log filtering. */
  address: OnchainAddress;
  /** What we believe this address represents. */
  kind: "proxy_contract" | "unknown_passthrough";
  /** Free-form note on why we resolved the way we did. */
  reason: string;
};

const HEX_40 = /^0x[0-9a-fA-F]{40}$/;

/**
 * Resolve any wallet-reference string the rest of the app might hand us into
 * the correct on-chain address to filter logs by.
 *
 * v1 is intentionally minimal — for every wallet we've sampled in production
 * (Data API `proxyWallet` rows + tracked_wallets), the value IS already the
 * on-chain proxy contract. We accept the input, lowercase-normalize it, and
 * tag with `proxy_contract`. We throw on malformed input rather than guessing.
 */
export function resolveOnchainAddress(input: string): ResolveProxyResult {
  const trimmed = input.trim();
  if (!HEX_40.test(trimmed)) {
    throw new Error(`resolveOnchainAddress: malformed address '${input}' — expected 0x + 40 hex chars`);
  }
  const lower = trimmed.toLowerCase() as OnchainAddress;
  return {
    address: lower,
    kind: "proxy_contract",
    reason: "Data API's `proxyWallet` field is already the on-chain proxy contract; passing through verbatim",
  };
}

/**
 * Heuristic: given a transaction receipt's OrderFilled logs, return the
 * unique set of addresses that appear as maker or taker. Used by the
 * proxy-self-discovery code path: if we know a wallet executed a trade and
 * we have its tx hash, we can read back which on-chain address actually
 * held the position. Useful for sanity-checking the data-API mapping.
 */
export function extractFillParticipants(
  logs: Array<{ address: string; topics: readonly string[] }>,
  orderFilledTopic0: string,
): OnchainAddress[] {
  const out = new Set<string>();
  const t0 = orderFilledTopic0.toLowerCase();
  for (const log of logs) {
    if ((log.topics[0] ?? "").toLowerCase() !== t0) continue;
    const maker = log.topics[2];
    const taker = log.topics[3];
    if (maker && maker.length >= 66) out.add("0x" + maker.slice(26).toLowerCase());
    if (taker && taker.length >= 66) out.add("0x" + taker.slice(26).toLowerCase());
  }
  return [...out] as OnchainAddress[];
}

/**
 * Given a wallet address and the participants extracted from one of its
 * recent transactions, return true if the wallet appears as a counterparty
 * on-chain — i.e. our data-API → on-chain mapping is correct.
 */
export function walletAppearsOnchain(wallet: string, participants: OnchainAddress[]): boolean {
  const target = wallet.trim().toLowerCase();
  return participants.some((p) => p === target);
}
