"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSiteSelection, withSite } from "./site-selection";

type Field = { key: string; label: string; value: string | number | boolean };
type Section = { key: string; title: string; fields: Field[]; error: string | null };
type DetailResponse = { station?: string; device?: { model?: string; status?: string }; sections?: Section[]; error?: string };
const useful = /status|power|voltage|frequency|temperature|percent|pv|grid|load|battery|peak|energy|current/i;

function display(field: Field) {
  if (typeof field.value !== "number" || !Number.isFinite(field.value)) return String(field.value);
  const value = Number.isInteger(field.value) ? field.value.toString() : field.value.toFixed(1);
  if (/frequency/i.test(field.key)) return `${value} Hz`;
  if (/temperature|temp/i.test(field.key)) return `${value} °C`;
  if (/voltage/i.test(field.key)) return `${value} V`;
  if (/percentage|percent|soc/i.test(field.key)) return `${value}%`;
  if (/power/i.test(field.key)) return `${value} W`;
  return value;
}

export default function DeviceDetails() {
  const { siteId } = useSiteSelection();
  const [data, setData] = useState<DetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(withSite("/api/itel/extended", siteId), { cache: "no-store", credentials: "same-origin" });
      const result = await response.json() as DetailResponse;
      setData(response.ok ? result : { error: result.error || "Detailed device data is unavailable" });
      if (response.ok) setLastUpdated(new Date());
    } catch { setData({ error: "Detailed device data is unavailable" }); }
    finally { setLoading(false); }
  }, [siteId]);
  useEffect(() => {
    const initial = window.setTimeout(() => void refresh(), 0);
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); };
  }, [refresh]);
  const fields = useMemo(() => {
    const all = (data?.sections ?? []).flatMap((section) => section.fields.map((field) => ({ ...field, section: section.title })));
    const priority = all.filter((field) => useful.test(`${field.key} ${field.label}`));
    return (priority.length ? priority : all).filter((field, index, collection) => collection.findIndex((other) => other.label === field.label && other.value === field.value) === index).slice(0, 48);
  }, [data]);
  const connectedSections = data?.sections?.filter((section) => section.fields.length).length ?? 0;

  return <>
    <div className={`status-strip ${data?.error ? "error" : ""}`}><span className={`live-pill ${data?.error ? "connecting" : ""}`}><i />{data?.error ? "Limited" : "Connected"}</span><p>{data?.error || `${data?.device?.model || "iTel inverter"} is exposing ${fields.length} detailed fields across ${connectedSections} provider data groups.`}</p><button className="quiet-button" onClick={() => void refresh()} disabled={loading}>{loading ? "Refreshing" : "Refresh"}</button></div>
    <section className="device-hero-grid">
      <article className="card device-health-card"><div className="device-illustration"><span>INV</span><i /></div><div><p className="eyebrow">Primary inverter</p><h2>{data?.device?.model || "iTel inverter"}</h2><strong><i /> {data?.device?.status === "online" ? "Operational status normal" : "Status pending"}</strong><small>{data?.station || "My Home"}</small></div></article>
      <article className="card provider-coverage-card"><p className="eyebrow">Provider coverage</p><strong>{connectedSections}<small>/ 4</small></strong><h2>iTel detail services responding</h2><p>Flow data remains live even if a model-specific detail service is unavailable.</p><span>{lastUpdated ? `Updated ${lastUpdated.toLocaleTimeString("en-PK", { hour: "numeric", minute: "2-digit" })}` : "Connecting"}</span></article>
    </section>
    <article className="card device-telemetry-card">
      <div className="card-heading"><div><p className="eyebrow">Real-time information</p><h2>Inverter measurements</h2></div><span className="status-badge">iTel provider fields</span></div>
      <p className="parameter-intro">Model-specific readings are shown with the field names returned by iTel. The portal does not infer missing voltages, temperatures or frequencies.</p>
      {fields.length ? <div className="device-field-grid">{fields.map((field) => <div key={`${field.key}-${field.value}`}><span>{field.label}</span><strong>{display(field)}</strong><small>{field.section}</small></div>)}</div> : <div className="device-empty"><strong>{loading ? "Loading detailed inverter data…" : "Detailed fields did not arrive"}</strong><p>The standard solar, load, grid and battery flow remains available on Overview.</p></div>}
    </article>
    {(data?.sections?.some((section) => section.error) || data?.error) && <article className="card endpoint-note"><p className="eyebrow">Provider compatibility</p><h2>Some iTel services are model-specific</h2><div>{data?.sections?.filter((section) => section.error).map((section) => <p key={section.key}><strong>{section.title}</strong><span>{section.error}</span></p>)}</div></article>}
  </>;
}
