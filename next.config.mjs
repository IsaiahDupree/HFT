/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Real type checking happens via `npx tsc --noEmit` and the vitest suite
  // (1200+ tests); ignoreBuildErrors removes a duplicated worker pool that
  // sometimes races on Windows. Next 15.5+ resolved the worst of the worker
  // races (we needed `experimental.workerThreads: false` on 15.1.6; not on
  // 15.5.14 — verified clean local build 2026-05-25).
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
  // Server-only packages that webpack should NOT bundle. Native modules
  // (better-sqlite3) and heavy SDKs that drag in many deps go here so the
  // worker-thread chunk emission doesn't race.
  serverExternalPackages: [
    "better-sqlite3",
    "@anthropic-ai/sdk",
    "@polymarket/clob-client",
    "@polymarket/clob-client-v2",
    "@polymarket/real-time-data-client",
    "@dydxprotocol/v4-client-js",
    "@dydxprotocol/v4-proto",
    "@cosmjs/stargate",
    "@cosmjs/proto-signing",
    "@cosmjs/tendermint-rpc",
    "@cosmjs/crypto",
    "ethers",
    "viem",
    "ws",
    "isomorphic-ws",
    "jose",
    "glpk.js",
  ],
};

export default nextConfig;
