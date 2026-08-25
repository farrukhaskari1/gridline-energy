"use client";

import { useEffect, useMemo, useState } from "react";
import { useSiteSelection, withSite } from "./site-selection";
import { BarChart, LineChart } from "./charts";

type Period = {
  periodKey: string; currency: string; generatedKwh: number; consumedKwh: number;
  gridImportKwh: number; gridExportKwh: number; selfConsumedKwh: number;
  estimatedSavings: number; estimatedGridCost: number; baselineCost: number; source: string; updatedAt: string;
} | null;

type Savings = {
  siteId: string; currency: string; today: Period; month: Period; year: Period;
  series: { days: Period[]; months: Period[]; years: Period[] };
};

function money(value: number, currency: string) {
  try { return new Intl.NumberFormat("en-PK", { style: "currency", currency, maximumFractionDigits: 0 }).format(value); }
  catch { return `${currency} ${Math.round(value).toLocaleString()}`; }
}
const kwh = (value: number) => `${(Math.round(value * 10) / 10).toLocaleString()}`;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function monthLabel(key: string) { const m = Number(key.slice(5, 7)); return MONTHS[m - 1] ?? key; }

function SourceChip({ source }: { source?: string }) {
  const provider = source === "provider";
  return <span className={`src-chip ${provider ? "provider" : ""}`}><i />{provider ? "Provider metered" : source ?? "—"}</span>;
}

export default function EnergySavings() {
  const { siteId } = useSiteSelection();
  const [data, setData] = useState<Savings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetch(withSite("/api/energy/savings", siteId), { cache: "no-store", credentials: "same-origin" })
      .then(async (response) => {
        const body = await response.json();
        if (cancelled) return;
        if (!response.ok) { setError(body.error ?? "Savings unavailable"); setData(null); }
        else { setData(body as Savings); setError(null); }
      })
      .catch(() => { if (!cancelled) setError("Savings unavailable"); })
      .finally(() => { if (!cancelled) setReady(true); });
    return () => { cancelled = true; };
  }, [siteId]);
  const loading = !ready && data === null && error === null;

  const currency = data?.currency ?? "PKR";
  const monthBars = useMemo(() => (data?.series.months ?? []).filter(Boolean).map((m) => ({ label: monthLabel(m!.periodKey), value: Math.max(0, m!.estimatedSavings) })), [data]);
  const yearLine = useMemo(() => (data?.series.years ?? []).filter(Boolean).map((y) => ({ label: y!.periodKey, value: Math.max(0, y!.estimatedSavings) })), [data]);

  if (loading) return <p className="viz-empty">Loading savings…</p>;
  if (error) return <div className="alerts-empty">{error}. Savings appear once ingestion has run for this account.</div>;
  if (!data || (!data.month && !data.year)) {
    return <div className="alerts-empty">No savings recorded yet. Ingestion pulls the provider’s metered totals into month and year savings — trigger it from Overview or wait for the next scheduled run.</div>;
  }

  const split = data.month ?? data.today;
  const splitParts = split ? [
    { key: "solar", label: "Solar self-used", value: Math.max(0, split.selfConsumedKwh), color: "var(--s-solar)" },
    { key: "export", label: "Exported", value: Math.max(0, split.gridExportKwh), color: "var(--s-export)" },
    { key: "import", label: "Grid import", value: Math.max(0, split.gridImportKwh), color: "var(--s-import)" },
  ] : [];
  const splitTotal = splitParts.reduce((sum, part) => sum + part.value, 0) || 1;

  return (
    <div className="savings-page">
      <section className="savings-hero">
        <article className="card">
          <p className="eyebrow">This month</p>
          <div className="amount">{money(data.month?.estimatedSavings ?? 0, currency)}</div>
          <div className="sub">{kwh(data.month?.selfConsumedKwh ?? 0)} kWh solar used on-site · {kwh(data.month?.gridExportKwh ?? 0)} kWh exported</div>
          <SourceChip source={data.month?.source} />
        </article>
        <article className="card accent">
          <p className="eyebrow">This year</p>
          <div className="amount">{money(data.year?.estimatedSavings ?? 0, currency)}</div>
          <div className="sub">vs {money(data.year?.baselineCost ?? 0, currency)} grid-only baseline</div>
          <SourceChip source={data.year?.source} />
        </article>
        <article className="card">
          <p className="eyebrow">Today</p>
          <div className="amount">{money(data.today?.estimatedSavings ?? 0, currency)}</div>
          <div className="sub">{kwh(data.today?.generatedKwh ?? 0)} kWh generated · {kwh(data.today?.consumedKwh ?? 0)} kWh used</div>
          <SourceChip source={data.today?.source} />
        </article>
      </section>

      <article className="card viz-card">
        <div className="viz-head"><div><h2>Monthly savings</h2><div className="viz-sub">Estimated money kept vs a grid-only bill, last 12 months</div></div></div>
        <div className="viz-legend"><span><i style={{ background: "var(--s-savings)" }} />Savings ({currency})</span></div>
        {monthBars.length ? <BarChart data={monthBars} colorKey="savings" format={(v) => money(v, currency)} /> : <div className="viz-empty">No monthly history yet.</div>}
      </article>

      <div className="dashboard-grid">
        <article className="card viz-card">
          <div className="viz-head"><div><h2>Yearly trend</h2><div className="viz-sub">Savings by year</div></div></div>
          {yearLine.length ? <LineChart data={yearLine} colorKey="savings" format={(v) => money(v, currency)} /> : <div className="viz-empty">A full year of history is still building.</div>}
        </article>
        <article className="card viz-card">
          <div className="viz-head"><div><h2>Where this month’s energy went</h2></div></div>
          <div className="energy-split">
            {splitParts.map((part) => (
              <div className="split-row" key={part.key}>
                <span>{part.label}</span>
                <div className="split-track"><i style={{ width: `${(part.value / splitTotal) * 100}%`, background: part.color }} /></div>
                <strong>{kwh(part.value)} kWh</strong>
              </div>
            ))}
          </div>
        </article>
      </div>
    </div>
  );
}
