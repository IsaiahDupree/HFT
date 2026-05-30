"use client";

/**
 * Operator-facing button to promote a paper agent to a live capsule.
 * POSTs to /api/arena/agents/[id]/promote-live with the form values.
 *
 * Renders inline-collapsed; clicking opens a small panel with the size knobs.
 * On success, the page should be refreshed by the operator to see the new
 * capsule binding — we don't auto-refresh to keep the verdict visible.
 */
import { useState } from "react";

export function PromoteToLiveButton({
  agentId, agentName, isElite, hasLiveCapsule,
}: {
  agentId: number;
  agentName: string;
  isElite: boolean;
  hasLiveCapsule: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [capital, setCapital] = useState("50");
  const [maxTrade, setMaxTrade] = useState("5");
  const [maxDailyLoss, setMaxDailyLoss] = useState("10");
  const [maxTotalDd, setMaxTotalDd] = useState("25");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  if (hasLiveCapsule) {
    return (
      <div className="text-xs text-zinc-500 italic">
        Live capsule already bound. Manage on <a className="text-accent-blue hover:underline" href="/capsules">/capsules</a>.
      </div>
    );
  }

  async function submit() {
    setBusy(true);
    setResult(null);
    try {
      const r = await fetch(`/api/arena/agents/${agentId}/promote-live`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          capitalUsd: Number(capital),
          maxTradeUsd: Number(maxTrade),
          maxDailyLossUsd: Number(maxDailyLoss),
          maxTotalDdUsd: Number(maxTotalDd),
        }),
      });
      const data = (await r.json()) as { capsule_id?: string; status?: string; error?: string; note?: string };
      if (!r.ok) {
        setResult(`ERROR: ${data.error ?? r.statusText}`);
      } else {
        setResult(`✓ Created capsule ${data.capsule_id?.slice(0, 8)}… (${data.status}). ${data.note ?? ""}`);
      }
    } catch (e) {
      setResult(`ERROR: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2">
      {!open ? (
        <button
          onClick={() => setOpen(true)}
          className={`px-3 py-1.5 text-xs rounded border ${
            isElite
              ? "bg-accent-amber/10 border-accent-amber/40 text-accent-amber hover:bg-accent-amber/20"
              : "bg-ink-800 border-ink-700 text-zinc-300 hover:bg-ink-700"
          }`}
        >
          {isElite ? "🏆 Promote to live capsule" : "Promote to live capsule"}
        </button>
      ) : (
        <div className="card border-accent-amber/30 bg-accent-amber/5 space-y-2">
          <h3 className="text-xs font-semibold text-accent-amber">Promote {agentName} → live capsule</h3>
          <p className="text-[10px] text-zinc-500">
            Creates a real-money capsule with the limits below. Orders only fire when ALLOW_TRADE=1 is set.
            Without it, the pipeline runs in DRY_RUN (audit-logged only).
          </p>
          <div className="grid grid-cols-4 gap-2 text-xs">
            <Field label="Capital ($)" value={capital} onChange={setCapital} />
            <Field label="Max trade ($)" value={maxTrade} onChange={setMaxTrade} />
            <Field label="Max daily loss ($)" value={maxDailyLoss} onChange={setMaxDailyLoss} />
            <Field label="Max total DD ($)" value={maxTotalDd} onChange={setMaxTotalDd} />
          </div>
          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={submit}
              disabled={busy}
              className="px-3 py-1.5 text-xs rounded bg-accent-amber/20 border border-accent-amber/40 text-accent-amber hover:bg-accent-amber/30 disabled:opacity-50"
            >
              {busy ? "Creating…" : "Create capsule + go live"}
            </button>
            <button
              onClick={() => { setOpen(false); setResult(null); }}
              className="px-3 py-1.5 text-xs rounded bg-ink-800 border border-ink-700 text-zinc-400 hover:bg-ink-700"
            >
              Cancel
            </button>
            {result && (
              <span className={`text-xs ${result.startsWith("ERROR") ? "text-accent-red" : "text-accent-green"}`}>
                {result}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] text-zinc-500">{label}</span>
      <input
        type="number"
        inputMode="decimal"
        step="any"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-ink-900 border border-ink-700 rounded px-2 py-1 text-zinc-200 focus:outline-none focus:border-accent-amber/60"
      />
    </label>
  );
}
