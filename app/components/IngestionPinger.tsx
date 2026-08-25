"use client";

import { useEffect } from "react";

/**
 * Keeps roll-ups fresh from the browser when no server cron is wired.
 *
 * Fires one ingestion on mount and every 10 minutes after — slow on purpose,
 * because the provider's period counters move slowly and each run makes several
 * statistics calls per site. Where a real Cloudflare Cron Trigger (or an uptime
 * pinger hitting `/api/energy/ingest`) exists, this is simply redundant.
 */
export function IngestionPinger() {
  useEffect(() => {
    let cancelled = false;
    const run = () => { void fetch("/api/energy/ingest", { method: "POST", cache: "no-store", credentials: "same-origin" }).catch(() => undefined); };
    const first = window.setTimeout(() => { if (!cancelled) run(); }, 4000);
    const timer = window.setInterval(run, 10 * 60 * 1000);
    return () => { cancelled = true; window.clearTimeout(first); window.clearInterval(timer); };
  }, []);
  return null;
}
