"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function PromoteButton({ strategyId, versionId, label }: { strategyId: number; versionId: number; label?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const res = await fetch(`/api/strategies/${strategyId}/promote`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ versionId }),
          });
          if (!res.ok) console.error("promote failed", await res.text());
          router.refresh();
        } finally {
          setBusy(false);
        }
      }}
      className="text-xs rounded px-2 py-1 bg-accent-green/15 text-accent-green hover:bg-accent-green/25 disabled:opacity-50"
    >{busy ? "…" : (label ?? "promote")}</button>
  );
}

export function RetireButton({ strategyId }: { strategyId: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      disabled={busy}
      onClick={async () => {
        if (!confirm("Retire this strategy? It will be marked inactive but versions remain.")) return;
        setBusy(true);
        try {
          await fetch(`/api/strategies/${strategyId}/retire`, { method: "POST" });
          router.refresh();
        } finally {
          setBusy(false);
        }
      }}
      className="text-xs rounded px-2 py-1 bg-accent-red/15 text-accent-red hover:bg-accent-red/25 disabled:opacity-50"
    >{busy ? "…" : "retire"}</button>
  );
}
