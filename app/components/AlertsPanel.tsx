"use client";

import { useEffect, useState } from "react";
import { useSiteSelection, withSite } from "./site-selection";

type Alert = { id: string; siteLabel: string; severity: string; title: string; message: string | null; occurredAt: string; acknowledged: boolean };

export default function AlertsPanel() {
  const { siteId } = useSiteSelection();
  const [alerts, setAlerts] = useState<Alert[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    void fetch(withSite("/api/alerts", siteId), { cache: "no-store", credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() as Promise<{ alerts: Alert[] }> : null))
      .then((body) => { if (!cancelled && body) setAlerts(body.alerts); })
      .catch(() => { if (!cancelled) setAlerts([]); });
    return () => { cancelled = true; };
  }, [siteId]);

  if (!alerts) return <div className="viz-empty">Loading alerts…</div>;
  if (alerts.length === 0) return <div className="alerts-empty">No provider alarms recorded. Gridline stores inverter faults here as they arrive.</div>;
  return (
    <div className="alerts-list">
      {alerts.map((alert) => (
        <div className={`alert-row ${alert.severity}`} key={alert.id}>
          <span className="alert-dot" />
          <div><h3>{alert.title}</h3><p>{alert.message ?? alert.siteLabel}</p></div>
          <time>{new Date(alert.occurredAt).toLocaleString("en-PK", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</time>
        </div>
      ))}
    </div>
  );
}
