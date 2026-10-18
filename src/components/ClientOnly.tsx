"use client";

import { useEffect, useState, type ReactNode } from "react";

/**
 * Render children only after first client mount. Use to wrap any child whose
 * server render and first client render might disagree (Date.now(), locale
 * formatting, randomness, polled state) — prevents the React 19 hydration
 * "server rendered HTML didn't match client" error by guaranteeing the
 * server emits ONLY the `fallback` and the client paints `children` on a
 * subsequent paint (post-hydration).
 *
 * Use sparingly — anything wrapped here is invisible to crawlers / curl
 * until JS runs.
 */
export function ClientOnly({ children, fallback = null }: { children: ReactNode; fallback?: ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  return mounted ? <>{children}</> : <>{fallback}</>;
}
