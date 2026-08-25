"use client";

import { useCallback, useEffect, useState } from "react";
import { useSiteSelection, withSite } from "./site-selection";

type RangeKey = "day" | "week" | "month";
type EventType = "all" | "added" | "removed";
type LoadEvent = { id: number; type: "added" | "removed"; occurredAt: string; beforeW: number; afterW: number; deltaW: number; confidence: string; stationName: string; sampleWindowSeconds: number | null };
type Payload = { events: LoadEvent[]; summary: { total: number; added: number; removed: number; netChangeW: number; largestChangeW: number }; error?: string };

const ranges: Array<{ key: RangeKey; label: string }> = [{ key: "day", label: "24 hours" }, { key: "week", label: "7 days" }, { key: "month", label: "30 days" }];
const types: Array<{ key: EventType; label: string }> = [{ key: "all", label: "All changes" }, { key: "added", label: "Added" }, { key: "removed", label: "Removed" }];

function power(value: number) {
  const absolute = Math.abs(value);
  return absolute >= 1000 ? `${absolute / 1000} kW` : `${absolute} W`;
}

function occurred(value: string) {
  return new Date(value).toLocaleString("en-PK", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export default function LoadEvents() {
  const { siteId } = useSiteSelection();
  const [range, setRange] = useState<RangeKey>("day");
  const [type, setType] = useState<EventType>("all");
  const [payload, setPayload] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async (runCollector = false) => {
    try {
      if (runCollector) await fetch(withSite("/api/itel/sync", siteId), { method: "POST", cache: "no-store", credentials: "same-origin" });
      const response = await fetch(withSite(`/api/activity/load-events?range=${range}&type=${type}`, siteId), { cache: "no-store", credentials: "same-origin" });
      const next = await response.json() as Payload;
      if (!response.ok) throw new Error(next.error || "Load events are unavailable");
      setPayload(next); setError(null);
    } catch (refreshError) { setError(refreshError instanceof Error ? refreshError.message : "Load events are unavailable"); }
    finally { setLoading(false); }
  }, [range, type, siteId]);

  useEffect(() => {
    const initial = window.setTimeout(() => { setLoading(true); void refresh(true); }, 0);
    const timer = window.setInterval(() => void refresh(true), 10_000);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); };
  }, [refresh]);

  const summary = payload?.summary ?? { total: 0, added: 0, removed: 0, netChangeW: 0, largestChangeW: 0 };

  return <>
    <div className="event-toolbar">
      <div className="segmented" aria-label="Event period">{ranges.map((item) => <button key={item.key} className={range === item.key ? "selected" : ""} onClick={() => setRange(item.key)}>{item.label}</button>)}</div>
      <div className="event-type-filters" aria-label="Load event type">{types.map((item) => <button key={item.key} className={type === item.key ? "active" : ""} onClick={() => setType(item.key)}>{item.label}</button>)}</div>
    </div>

    <div className="log-summary real-event-summary">
      <div><strong>{summary.total}</strong><span>Detected changes</span></div>
      <div><strong className="added-value">+{summary.added}</strong><span>Loads added</span></div>
      <div><strong className="removed-value">−{summary.removed}</strong><span>Loads removed</span></div>
      <div><strong>{power(summary.largestChangeW)}</strong><span>Largest change</span></div>
    </div>

    <article className="card activity-card load-events-card">
      <div className="card-heading"><div><p className="eyebrow">Power-step detection</p><h2>Load changes</h2></div><span className={`event-live-state ${error ? "error" : ""}`}><i />{error ? "Collector issue" : "Watching live"}</span></div>
      <p className="event-method">A change is listed when demand moves by at least 75 W and 15% between nearby online readings. Gridline reports the electrical change without guessing the appliance.</p>
      {error && <div className="data-notice error"><strong>Events unavailable</strong><span>{error}</span><button onClick={() => void refresh(true)}>Try again</button></div>}
      <div className={`load-event-list ${loading ? "is-loading" : ""}`}>
        {!loading && !error && !payload?.events.length && <div className="empty-events"><span className="event-empty-mark" /><strong>No load changes detected</strong><p>Turn a meaningful load on or off and it will appear after the next readings arrive.</p></div>}
        {payload?.events.map((event) => <article className={`load-event ${event.type}`} key={event.id}>
          <div className="event-change-icon"><span>{event.type === "added" ? "+" : "−"}</span></div>
          <div className="event-copy"><div><strong>Load {event.type}</strong><span className={`confidence ${event.confidence}`}>{event.confidence} confidence</span></div><p>{power(event.beforeW)} <i>→</i> {power(event.afterW)} at {event.stationName}</p></div>
          <div className="event-delta"><strong>{event.type === "added" ? "+" : "−"}{power(event.deltaW)}</strong><time>{occurred(event.occurredAt)}</time></div>
        </article>)}
      </div>
    </article>
  </>;
}
