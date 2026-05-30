// Module-level singleton for the dev/PoC dYdX MM engine. The Next dev server
// is a single Node process, so a module-level Map survives across API calls.
// In prod this would move to a dedicated worker, but the contract stays the
// same: one engine per (address, market).
import { MmEngine, type EngineConfig } from "./mm-engine";

const engines = new Map<string, MmEngine>();

function key(net: string, market: string): string {
  return `${net}|${market}`;
}

export function getEngine(net: string, market: string): MmEngine | undefined {
  return engines.get(key(net, market));
}

export async function startEngine(opts: EngineConfig): Promise<MmEngine> {
  const k = key(opts.net, opts.market);
  const existing = engines.get(k);
  if (existing) {
    if (existing.getStatus().running) return existing;
    // Replace stale stopped instance with a fresh one to pick up new config.
    engines.delete(k);
  }
  const engine = await MmEngine.create(opts);
  engine.start();
  engines.set(k, engine);
  return engine;
}

export async function stopEngine(net: string, market: string, reason = "user"): Promise<MmEngine | undefined> {
  const engine = engines.get(key(net, market));
  if (!engine) return undefined;
  await engine.stop(reason);
  return engine;
}

export function listEngines(): Array<{ net: string; market: string; running: boolean }> {
  return Array.from(engines.values()).map((e) => {
    const s = e.getStatus();
    return { net: s.net, market: s.market, running: s.running };
  });
}
