"use client";

import { useEffect, useState } from "react";
import { ALL_SITES, useSiteSelection } from "./site-selection";

type Site = { siteId: string; displayName: string; accountLabel: string | null; hidden: boolean };

/**
 * Scope picker in the top bar.
 *
 * A native `<select>` on purpose: it is keyboard accessible, announces itself
 * to screen readers, and behaves correctly on a phone without any of the focus
 * management a hand-rolled dropdown needs to get right.
 */
export function SiteSelector() {
  const { siteId, select } = useSiteSelection();
  const [sites, setSites] = useState<Site[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/sites", { cache: "no-store", credentials: "same-origin" })
      .then((response) => response.ok ? response.json() as Promise<{ sites: Site[] }> : null)
      .then((payload) => { if (!cancelled && payload) setSites(payload.sites.filter((site) => !site.hidden)); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!sites || siteId === ALL_SITES) return;
    if (!sites.some((site) => !site.hidden && site.siteId === siteId)) select(ALL_SITES);
  }, [select, siteId, sites]);

  // One inverter needs no picker, and an empty one is worse than none at all.
  if (!sites || sites.length < 2) {
    return <span className="site-picker site-picker-static">{sites?.[0]?.displayName ?? "Gridline"}</span>;
  }

  const selected = sites.some((site) => site.siteId === siteId) ? siteId : ALL_SITES;
  return (
    <label className="site-picker">
      <span className="visually-hidden">Inverter shown</span>
      <select value={selected} onChange={(event) => select(event.target.value)}>
        <option value={ALL_SITES}>All inverters ({sites.length})</option>
        {sites.map((site) => (
          <option key={site.siteId} value={site.siteId}>
            {site.accountLabel && site.accountLabel !== site.displayName ? `${site.displayName} — ${site.accountLabel}` : site.displayName}
          </option>
        ))}
      </select>
    </label>
  );
}
