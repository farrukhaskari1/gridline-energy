"use client";

import { useEffect } from "react";
import { readSiteSelection, withSite } from "./site-selection";

/**
 * Drives the site-wide atmosphere from the live system state.
 *
 * Weather already sets the climate hues; this layers the house's own condition
 * on top — how much is being generated, how hard the inverter is working, and
 * whether anything is critical — and writes it to the document root so every
 * page follows, not just the overview.
 */
type Reading = {
  telemetry?: {
    pvPowerW?: number | null;
    loadPowerW?: number | null;
    online?: boolean;
  };
};

type Capacities = { inverterCapacityW: number; solarCapacityW: number };
type History = { points?: Array<{ solarW?: number; loadW?: number; onlinePercent?: number }> };

const DEFAULT_CAPACITIES: Capacities = { inverterCapacityW: 4000, solarCapacityW: 4680 };
const READING_EVENT = "gridline:reading";
/** Overview publishes every 10s; only poll independently when it is not mounted. */
const FALLBACK_POLL_MS = 20_000;
const PUBLISHER_GRACE_MS = 30_000;

function clamp01(value: number) {
  return Math.min(1, Math.max(0, value));
}

function numeric(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function energyState(loadPercent: number | null, generation: number, online: boolean) {
  if (!online) return "outage";
  if (loadPercent !== null && loadPercent >= 90) return "critical";
  if (loadPercent !== null && loadPercent >= 70) return "heavy";
  if (generation >= 0.2) return "producing";
  return "calm";
}

export function EnergyAtmosphere() {
  useEffect(() => {
    let active = true;
    let capacities = DEFAULT_CAPACITIES;
    let lastPublishedAt = 0;
    const root = document.documentElement;

    function apply(reading: Reading) {
      const solar = numeric(reading.telemetry?.pvPowerW) ?? 0;
      const load = numeric(reading.telemetry?.loadPowerW) ?? 0;
      const online = reading.telemetry?.online !== false;
      const generation = clamp01(solar / Math.max(1, capacities.solarCapacityW));
      const demand = clamp01(load / Math.max(1, capacities.inverterCapacityW));
      const loadPercent = demand * 100;

      root.style.setProperty("--generation-intensity", generation.toFixed(3));
      root.style.setProperty("--demand-intensity", demand.toFixed(3));
      root.dataset.energyState = energyState(loadPercent, generation, online);
    }

    async function loadCapacities() {
      try {
        const response = await fetch(withSite("/api/settings/energy", readSiteSelection()), { cache: "no-store", credentials: "same-origin" });
        if (!response.ok) return;
        const body = await response.json() as Partial<Capacities>;
        if (!active) return;
        capacities = {
          inverterCapacityW: numeric(body.inverterCapacityW) ?? DEFAULT_CAPACITIES.inverterCapacityW,
          solarCapacityW: numeric(body.solarCapacityW) ?? DEFAULT_CAPACITIES.solarCapacityW,
        };
      } catch { /* Defaults keep the atmosphere readable. */ }
    }

    function onPublished(event: Event) {
      lastPublishedAt = Date.now();
      const detail = (event as CustomEvent<Reading>).detail;
      if (detail) apply(detail);
    }

    async function poll() {
      // The overview page already polls; piggy-backing on its readings avoids
      // doubling the traffic to the provider.
      if (Date.now() - lastPublishedAt < PUBLISHER_GRACE_MS) return;
      try {
        const response = await fetch(withSite("/api/energy/history?range=day", readSiteSelection()), { cache: "no-store", credentials: "same-origin" });
        if (!response.ok) return;
        const body = await response.json() as History;
        const latest = body.points?.at(-1);
        if (active && latest) apply({ telemetry: { pvPowerW: latest.solarW, loadPowerW: latest.loadW, online: (latest.onlinePercent ?? 0) > 0 } });
      } catch { /* A missed atmosphere update is not worth surfacing. */ }
    }

    void loadCapacities().then(() => { if (active) void poll(); });
    window.addEventListener(READING_EVENT, onPublished);
    const timer = window.setInterval(() => void poll(), FALLBACK_POLL_MS);

    return () => {
      active = false;
      window.removeEventListener(READING_EVENT, onPublished);
      window.clearInterval(timer);
      root.style.removeProperty("--generation-intensity");
      root.style.removeProperty("--demand-intensity");
      delete root.dataset.energyState;
    };
  }, []);

  return null;
}

/** Called by the overview once a live reading lands, so the whole site follows it. */
export function publishReading(reading: unknown) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(READING_EVENT, { detail: reading }));
}
