"use client";

import { useState } from "react";

type PreviewResult = {
  verdict: "would-pass" | "would-fail" | "no-binding";
  backtest?: { pnl_pct: number; max_dd_pct: number; fitness: number; trades_count: number; win_rate: number; ticks: number };
  thresholds?: { min_pnl_pct: number; max_dd_pct: number; window_days: number };
  checks?: { pnl_ok: boolean; dd_ok: boolean };
  bound_paper_agent?: { id: number; name: string; genome_kind: string; generation: number };
  reason?: string;
};

/**
 * Per-capsule activation form. Two safety affordances:
 *   - "Preview gate" runs the same backtest that activation runs, no state
 *     changes, shows the verdict inline so you see whether activation will
 *     pass before clicking the big red button.
 *   - "Bypass" checkbox passes bypass=true to the activation API. The bypass
 *     is logged separately in evolution_log so audits can flag it.
 *
 * Default for bypass is OFF — the activation gate is enforced unless the
 * operator explicitly opts out.
 */
export function ActivateForm({ capsuleId }: { capsuleId: string }) {
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [bypass, setBypass] = useState(false);
  const [activating, setActivating] = useState(false);
  const [activationError, setActivationError] = useState<string | null>(null);

  async function onPreview() {
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const r = await fetch(`/api/capsules/${capsuleId}/activate-preview`);
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error ?? `HTTP ${r.status}`);
      setPreview(data);
    } catch (err) {
      setPreviewError((err as Error).message);
    } finally {
      setPreviewLoading(false);
    }
  }

  async function onActivate(e: React.FormEvent) {
    e.preventDefault();
    setActivating(true);
    setActivationError(null);
    try {
      const r = await fetch(`/api/capsules/${capsuleId}/activate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ activated_by: "operator-ui", bypass }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.reason ?? data?.error ?? `HTTP ${r.status}`);
      // Reload to reflect new status.
      window.location.reload();
    } catch (err) {
      setActivationError((err as Error).message);
    } finally {
      setActivating(false);
    }
  }

  return (
    <div className="inline-flex flex-col gap-1 items-end">
      <div className="flex gap-2 items-center">
        <button
          type="button"
          onClick={onPreview}
          disabled={previewLoading}
          className="text-xs px-2 py-1 rounded bg-accent-blue/15 text-accent-blue hover:bg-accent-blue/25 disabled:opacity-50"
        >
          {previewLoading ? "Running gate…" : "Preview gate"}
        </button>
        <form onSubmit={onActivate} className="inline-flex items-center gap-2">
          <label className="text-[10px] text-zinc-500 inline-flex items-center gap-1 cursor-pointer">
            <input
              type="checkbox"
              checked={bypass}
              onChange={(e) => setBypass(e.target.checked)}
              className="accent-accent-red"
            />
            Bypass gate
          </label>
          <button
            type="submit"
            disabled={activating}
            className={`text-xs px-2 py-1 rounded ${bypass ? "bg-accent-red/30 text-accent-red border border-accent-red/40" : "bg-accent-red/15 text-accent-red"} hover:bg-accent-red/25 disabled:opacity-50`}
          >
            {activating ? "Activating…" : bypass ? "Activate LIVE (bypass)" : "Activate LIVE"}
          </button>
        </form>
      </div>
      {previewError && <p className="text-[10px] text-accent-red">preview error: {previewError}</p>}
      {activationError && <p className="text-[10px] text-accent-red max-w-xs">activation: {activationError}</p>}
      {preview && (
        <div className={`text-[10px] px-2 py-1 rounded mt-1 ${
          preview.verdict === "would-pass" ? "bg-accent-green/10 text-accent-green" :
          preview.verdict === "would-fail" ? "bg-accent-red/10 text-accent-red" :
          "bg-accent-amber/10 text-accent-amber"
        }`}>
          {preview.verdict === "no-binding" && <span>no bound paper_agent — gate would be skipped</span>}
          {preview.backtest && (
            <span>
              gate: <strong>{preview.verdict}</strong> · pnl {(preview.backtest.pnl_pct * 100).toFixed(2)}% ·
              dd {(preview.backtest.max_dd_pct * 100).toFixed(2)}% · fit {preview.backtest.fitness.toFixed(4)} ·
              {preview.backtest.trades_count} trades over {preview.backtest.ticks} ticks
            </span>
          )}
        </div>
      )}
    </div>
  );
}
