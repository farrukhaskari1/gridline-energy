"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSiteSelection, withSite } from "./site-selection";

type RangeKey = "day" | "twoDays" | "week" | "month" | "year" | "lifetime";
type SourceKey = "load" | "solar" | "grid" | "battery";
type Point = { time: string; samples: number; representedSeconds: number; solarW: number; loadW: number; gridW: number; batteryW: number; batterySoc: number; generatorW: number; onlinePercent: number };
type History = {
  range: RangeKey; label: string; bucketSeconds: number; from: string; to: string;
  coverage: { percent: number; observedSeconds: number; samples: number; firstAt: string | null; lastAt: string | null };
  points: Point[];
  summary: { solarKWh: number; consumptionKWh: number; gridImportKWh: number; gridExportKWh: number; generatorKWh: number; selfSufficiencyPercent: number; gridDependencePercent: number; solarToDemandPercent: number; solarSelfConsumedKWh: number; loadFactorPercent: number; peakLoadW: number; peakAt: string | null; peakSolarW: number; peakSolarAt: string | null; averageLoadW: number; batteryStartPercent: number | null; batteryEndPercent: number | null; batteryMinPercent: number | null; batteryMaxPercent: number | null; batteryAveragePercent: number | null; availabilityPercent: number };
  insights: string[];
};
type EnergySettings = { currency: string; importTariffPerKwh: number | null; exportCreditPerKwh: number | null; inverterCapacityW: number; solarCapacityW: number; gridExportOffset: number; solarPanelCost: number; inverterBatteryCost: number; installationCost: number; totalSystemCost: number; configured: boolean; updatedAt: string | null; error?: string };

const periods: Array<{ key: RangeKey; label: string }> = [{ key: "day", label: "Day" }, { key: "twoDays", label: "2 days" }, { key: "week", label: "Week" }, { key: "month", label: "Month" }, { key: "year", label: "Year" }, { key: "lifetime", label: "Lifetime" }];
const sources: Array<{ key: SourceKey; label: string }> = [{ key: "solar", label: "Solar" }, { key: "battery", label: "Battery" }, { key: "load", label: "Home load" }, { key: "grid", label: "Grid" }];

function energy(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0.00";
  return value < .01 ? "<0.01" : value.toFixed(2);
}

function power(value: number) {
  return Math.abs(value) >= 1000 ? `${value / 1000} kW` : `${value} W`;
}

function dateTime(value: string | null, range: RangeKey) {
  if (!value) return "—";
  return new Date(value).toLocaleString("en-PK", range === "day" ? { hour: "numeric", minute: "2-digit" } : { month: "short", day: "numeric", hour: "numeric" });
}

function percent(value: number) {
  return `${Math.max(0, value).toFixed(1)}%`;
}

function money(value: number, currency = "PKR") {
  return new Intl.NumberFormat("en-PK", { style: "currency", currency, maximumFractionDigits: 0 }).format(value);
}

export default function EnergyAnalytics() {
  const { siteId } = useSiteSelection();
  const [range, setRange] = useState<RangeKey>("day");
  const [activeSources, setActiveSources] = useState<Set<SourceKey>>(new Set(["load", "solar", "grid", "battery"]));
  const [history, setHistory] = useState<History | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<EnergySettings | null>(null);
  const [settingsDraft, setSettingsDraft] = useState({ importTariffPerKwh: "63", exportCreditPerKwh: "0", inverterCapacityW: "4000", solarCapacityW: "4680", gridExportOffset: "2", solarPanelCost: "218440", inverterBatteryCost: "233000", installationCost: "181500" });
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsMessage, setSettingsMessage] = useState<string | null>(null);

  const load = useCallback(async (nextRange: RangeKey) => {
    setLoading(true); setError(null);
    try {
      const response = await fetch(withSite(`/api/energy/history?range=${nextRange}`, siteId), { cache: "no-store", credentials: "same-origin" });
      const result = await response.json() as History & { error?: string };
      if (!response.ok) throw new Error(result.error || "Energy history is unavailable");
      setHistory(result);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Energy history is unavailable");
    } finally { setLoading(false); }
  }, [siteId]);

  // `load` changes identity when the scope does, so switching inverter refetches.
  useEffect(() => {
    const initial = window.setTimeout(() => void load(range), 0);
    return () => window.clearTimeout(initial);
  }, [load, range]);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch(withSite("/api/settings/energy", siteId), { cache: "no-store", credentials: "same-origin" });
        const result = await response.json() as EnergySettings;
        if (!response.ok) throw new Error(result.error || "Settings are unavailable");
        setSettings(result);
        setSettingsDraft({
          importTariffPerKwh: result.importTariffPerKwh?.toString() ?? "",
          exportCreditPerKwh: result.exportCreditPerKwh?.toString() ?? "",
          inverterCapacityW: result.inverterCapacityW.toString(),
          solarCapacityW: result.solarCapacityW.toString(),
          gridExportOffset: result.gridExportOffset.toString(),
          solarPanelCost: result.solarPanelCost.toString(),
          inverterBatteryCost: result.inverterBatteryCost.toString(),
          installationCost: result.installationCost.toString(),
        });
      } catch (settingsError) {
        setSettingsMessage(settingsError instanceof Error ? settingsError.message : "Settings are unavailable");
      }
    })();
  }, [siteId]);

  const maxPower = useMemo(() => Math.max(1, ...(history?.points.flatMap((point) => [point.loadW, point.solarW, Math.abs(point.gridW), Math.abs(point.batteryW)]) ?? [1])), [history]);
  const chartSeries = useMemo(() => {
    const points = history?.points ?? [];
    const line = (value: (point: Point) => number) => points.map((point, index) => {
      const x = points.length <= 1 ? 0 : index / (points.length - 1) * 1000;
      const y = 240 - Math.min(1, Math.max(0, value(point) / maxPower)) * 220;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");
    return { solar: line((point) => point.solarW), battery: line((point) => Math.abs(point.batteryW)), load: line((point) => point.loadW), grid: line((point) => Math.abs(point.gridW)) };
  }, [history, maxPower]);
  const localKWh = Math.max(0, (history?.summary.consumptionKWh ?? 0) - (history?.summary.gridImportKWh ?? 0));
  const hasObservedConsumption = (history?.summary.consumptionKWh ?? 0) > 0;
  const importShare = hasObservedConsumption ? Math.min(100, history!.summary.gridImportKWh / history!.summary.consumptionKWh * 100) : 0;
  const localShare = hasObservedConsumption ? 100 - importShare : 0;
  const rate = settings?.importTariffPerKwh ?? null;
  const exportRate = settings?.exportCreditPerKwh ?? 0;
  const effectiveExportRate = exportRate > 0 ? exportRate : rate !== null && settings?.gridExportOffset ? rate / settings.gridExportOffset : 0;
  const solarSelfConsumedKWh = history?.summary.solarSelfConsumedKWh ?? 0;
  const gridExportKWh = history?.summary.gridExportKWh ?? 0;
  const consumptionKWh = history?.summary.consumptionKWh ?? 0;
  const estimatedSavings = rate === null ? null : solarSelfConsumedKWh * rate + gridExportKWh * effectiveExportRate;
  const estimatedGridCost = rate === null ? null : Math.max(0, (history?.summary.gridImportKWh ?? 0) * rate - gridExportKWh * effectiveExportRate);
  const baselineGridCost = rate === null ? null : consumptionKWh * rate;
  const savingsPercent = estimatedSavings !== null && baselineGridCost && baselineGridCost > 0 ? estimatedSavings / baselineGridCost * 100 : null;
  const peakLoadUtilization = history && settings ? history.summary.peakLoadW / settings.inverterCapacityW * 100 : 0;
  const peakSolarUtilization = history && settings ? history.summary.peakSolarW / settings.solarCapacityW * 100 : 0;
  const savingsPerObservedMonth = estimatedSavings !== null && history?.coverage.observedSeconds ? estimatedSavings / history.coverage.observedSeconds * 2_592_000 : null;
  const paybackMonths = savingsPerObservedMonth && savingsPerObservedMonth > 0 && settings ? settings.totalSystemCost / savingsPerObservedMonth : null;
  const paybackReady = Boolean(history && history.coverage.percent >= 25 && paybackMonths && Number.isFinite(paybackMonths));
  const paybackProgress = settings && estimatedSavings !== null && settings.totalSystemCost > 0 ? Math.min(100, estimatedSavings / settings.totalSystemCost * 100) : 0;

  function toggleSource(source: SourceKey) {
    setActiveSources((current) => {
      const next = new Set(current);
      if (next.has(source) && next.size > 1) next.delete(source); else next.add(source);
      return next;
    });
  }

  function exportCsv() {
    if (!history?.points.length) return;
    const rows = [["timestamp", "solar_w", "load_w", "grid_w", "battery_w", "battery_soc_percent", "generator_w", "online_percent", "represented_seconds", "samples"], ...history.points.map((point) => [point.time, point.solarW, point.loadW, point.gridW, point.batteryW, point.batterySoc, point.generatorW, point.onlinePercent, point.representedSeconds, point.samples])];
    const blob = new Blob([rows.map((row) => row.join(",")).join("\n")], { type: "text/csv;charset=utf-8" });
    const href = URL.createObjectURL(blob); const anchor = document.createElement("a");
    anchor.href = href; anchor.download = `gridline-${range}-${new Date().toISOString().slice(0, 10)}.csv`; anchor.click(); URL.revokeObjectURL(href);
  }

  async function saveSettings() {
    if (settingsDraft.importTariffPerKwh.trim() === "") { setSettingsMessage("Enter your grid import tariff to calculate money savings."); return; }
    setSavingSettings(true); setSettingsMessage(null);
    try {
      const response = await fetch(withSite("/api/settings/energy", siteId), { method: "PUT", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(settingsDraft) });
      const result = await response.json() as EnergySettings;
      if (!response.ok) throw new Error(result.error || "Settings could not be saved");
      setSettings(result); setSettingsMessage("Assumptions saved. Savings have been recalculated.");
    } catch (saveError) {
      setSettingsMessage(saveError instanceof Error ? saveError.message : "Settings could not be saved");
    } finally { setSavingSettings(false); }
  }

  return <>
    <div className="page-toolbar analytics-toolbar">
      <div className="segmented" aria-label="Analysis period">{periods.map((period) => <button className={range === period.key ? "selected" : ""} onClick={() => setRange(period.key)} key={period.key} disabled={loading && range === period.key}>{period.label}</button>)}</div>
      <button className="export-button" onClick={exportCsv} disabled={!history?.points.length}>Export readings</button>
    </div>

    {error && <div className="data-notice error"><strong>History unavailable</strong><span>{error}</span><button onClick={() => void load(range)}>Try again</button></div>}
    {!error && history && history.coverage.percent < 95 && <div className="data-notice"><strong>{history.coverage.percent.toFixed(1)}% recorded coverage</strong><span>Totals below include only periods with stored readings. Missing time is not guessed.</span></div>}

    <section className={`metric-grid meaningful-metrics ${loading ? "is-loading" : ""}`}>
      <article><span>Observed consumption</span><strong>{history ? energy(history.summary.consumptionKWh) : "—"} <small>kWh</small></strong><em>{history ? `${power(history.summary.averageLoadW)} average demand` : "Loading stored readings"}</em></article>
      <article><span>Solar produced</span><strong>{history ? energy(history.summary.solarKWh) : "—"} <small>kWh</small></strong><em>{history ? `${energy(history.summary.gridExportKWh)} kWh exported` : "Loading stored readings"}</em></article>
      <article><span>Self-sufficiency</span><strong>{history ? history.summary.selfSufficiencyPercent.toFixed(0) : "—"} <small>%</small></strong><em>{history ? `${energy(localKWh)} kWh supplied locally` : "Loading stored readings"}</em></article>
      <article><span>Peak observed load</span><strong>{history ? power(history.summary.peakLoadW) : "—"}</strong><em>{history ? dateTime(history.summary.peakAt, range) : "Loading stored readings"}</em></article>
    </section>

    <section className="savings-grid" aria-label="Estimated energy savings">
      <article className="savings-hero"><p className="eyebrow">Estimated savings</p><strong>{estimatedSavings === null ? "Set tariff" : money(estimatedSavings, settings?.currency)}</strong><span>{estimatedSavings === null ? "Add your import rate below to value avoided grid energy." : `${energy(solarSelfConsumedKWh)} kWh of solar used onsite plus export credit.`}</span></article>
      <article><span>Grid energy avoided</span><strong>{energy(solarSelfConsumedKWh)} <small>kWh</small></strong><em>Solar consumed by the home</em></article>
      <article><span>Estimated grid cost</span><strong>{estimatedGridCost === null ? "Set tariff" : money(estimatedGridCost, settings?.currency)}</strong><em>Imports less configured export credit</em></article>
      <article><span>Savings vs grid-only</span><strong>{savingsPercent === null ? "—" : percent(savingsPercent)}</strong><em>Observed interval comparison</em></article>
    </section>

    <article className="card payback-card">
      <div><p className="eyebrow">Real-world return</p><h2>{paybackReady ? `${paybackMonths!.toFixed(1)} month estimated payback` : "Building a reliable payback estimate"}</h2><p>{paybackReady ? `At the savings pace observed during recorded coverage, the ${money(settings!.totalSystemCost, settings?.currency)} system cost would be recovered in about ${(paybackMonths! / 12).toFixed(1)} years.` : "Payback is shown only after at least 25% of the selected period has real readings. This prevents a short sunny or overnight window from becoming a misleading ROI forecast."}</p></div>
      <div className="payback-progress"><div><i style={{ width: `${paybackProgress}%` }} /></div><strong>{paybackProgress.toFixed(2)}%</strong><span>Selected-period value vs cost</span></div>
      <dl><div><dt>Total system cost</dt><dd>{settings ? money(settings.totalSystemCost, settings.currency) : "—"}</dd></div><div><dt>Solar panels</dt><dd>{settings ? money(settings.solarPanelCost, settings.currency) : "—"}</dd></div><div><dt>Inverter + battery</dt><dd>{settings ? money(settings.inverterBatteryCost, settings.currency) : "—"}</dd></div><div><dt>Installation + fees</dt><dd>{settings ? money(settings.installationCost, settings.currency) : "—"}</dd></div></dl>
    </article>

    <article className="card analytics-card real-analytics-card">
      <div className="card-heading chart-controls"><div><p className="eyebrow">{history?.label || "Stored telemetry"}</p><h2>Real-time power chart</h2></div><div className="source-filters" aria-label="Visible data series">{sources.map((source) => <button key={source.key} className={`${source.key}-filter ${activeSources.has(source.key) ? "active" : ""}`} aria-pressed={activeSources.has(source.key)} onClick={() => toggleSource(source.key)}><i />{source.label}</button>)}</div></div>
      <div className={`history-chart line-history-chart ${loading ? "is-loading" : ""}`} aria-label="Power history chart">
        {!loading && !history?.points.length && <div className="empty-chart"><strong>No readings in this period</strong><span>Live readings are stored while the Overview collector is running.</span></div>}
        {!!history?.points.length && <svg viewBox="0 0 1000 260" preserveAspectRatio="none" role="img" aria-label={`${history.label} solar, battery, home load and grid power`}>
          <g className="chart-grid-lines"><line x1="0" y1="20" x2="1000" y2="20"/><line x1="0" y1="75" x2="1000" y2="75"/><line x1="0" y1="130" x2="1000" y2="130"/><line x1="0" y1="185" x2="1000" y2="185"/><line x1="0" y1="240" x2="1000" y2="240"/></g>
          {activeSources.has("grid") && <polyline className="power-line grid-power-line" points={chartSeries.grid}/>}
          {activeSources.has("load") && <polyline className="power-line load-power-line" points={chartSeries.load}/>}
          {activeSources.has("solar") && <polyline className="power-line solar-power-line" points={chartSeries.solar}/>}
          {activeSources.has("battery") && <polyline className="power-line battery-power-line" points={chartSeries.battery}/>}
        </svg>}
        {!!history?.points.length && <div className="chart-scale"><span>{power(maxPower)}</span><span>{power(maxPower / 2)}</span><span>0 W</span></div>}
      </div>
      <div className="chart-footer"><span>{history?.coverage.firstAt ? dateTime(history.coverage.firstAt, range) : "Start"}</span><strong>{history ? `${history.coverage.samples.toLocaleString()} readings · ${history.points.length} time buckets` : "Loading"}</strong><span>{history?.coverage.lastAt ? dateTime(history.coverage.lastAt, range) : "Latest"}</span></div>
    </article>

    <div className="two-column meaningful-grid">
      <article className="card breakdown-card">
        <p className="eyebrow">Observed supply</p><h2>How demand was met</h2>
        <div className="source-bar real-source-bar"><i className="from-local" style={{ width: `${localShare}%` }} /><i className="from-grid-real" style={{ width: `${importShare}%` }} /></div>
        <div className="source-list"><p><span><i className="solar-key" /> Local supply</span><strong>{localShare.toFixed(0)}% · {energy(localKWh)} kWh</strong></p><p><span><i className="load-key" /> Grid import</span><strong>{importShare.toFixed(0)}% · {history ? energy(history.summary.gridImportKWh) : "0.00"} kWh</strong></p><p><span><i className="cyan-key" /> Grid export</span><strong>{history ? energy(history.summary.gridExportKWh) : "0.00"} kWh</strong></p></div>
      </article>
      <article className="card insight-list-card"><p className="eyebrow">What this means</p><h2>Interpretation</h2><div className="insight-list">{(history?.insights.length ? history.insights : ["Collecting enough readings to produce a reliable interpretation."]).map((insight, index) => <p key={insight}><span>{String(index + 1).padStart(2, "0")}</span>{insight}</p>)}</div></article>
    </div>


    <article className="card parameter-card">
      <div className="card-heading"><div><p className="eyebrow">Complete period view</p><h2>Available parameters</h2></div><span className="status-badge">Observed + calculated</span></div>
      <p className="parameter-intro">Every stored iTel measurement and the useful indicators derived from it. Percentages use only recorded intervals; missing time is never estimated.</p>
      <div className="parameter-grid">
        <div><span>Grid dependence</span><strong>{history ? percent(history.summary.gridDependencePercent) : "—"}</strong><small>Imported energy ÷ demand</small></div>
        <div><span>Solar vs demand</span><strong>{history ? percent(history.summary.solarToDemandPercent) : "—"}</strong><small>Solar energy ÷ demand — above 100% means surplus</small></div>
        <div><span>Peak load capacity</span><strong>{history && settings ? percent(peakLoadUtilization) : "—"}</strong><small>Peak load ÷ inverter rating</small></div>
        <div><span>Peak solar capacity</span><strong>{history && settings ? percent(peakSolarUtilization) : "—"}</strong><small>Peak solar ÷ array rating</small></div>
        <div><span>Load factor</span><strong>{history ? percent(history.summary.loadFactorPercent) : "—"}</strong><small>Average ÷ peak demand</small></div>
        <div><span>Device availability</span><strong>{history ? percent(history.summary.availabilityPercent) : "—"}</strong><small>Readings reported online</small></div>
        <div><span>Generator energy</span><strong>{history ? `${energy(history.summary.generatorKWh)} kWh` : "—"}</strong><small>Observed generator output</small></div>
        <div><span>Grid export</span><strong>{history ? `${energy(history.summary.gridExportKWh)} kWh` : "—"}</strong><small>Energy sent to grid</small></div>
        <div><span>Battery average</span><strong>{history?.summary.batteryAveragePercent == null ? "—" : percent(history.summary.batteryAveragePercent)}</strong><small>Time-weighted state of charge</small></div>
        <div><span>Battery range</span><strong>{history?.summary.batteryMinPercent == null || history.summary.batteryMaxPercent == null ? "—" : `${history.summary.batteryMinPercent.toFixed(0)}–${history.summary.batteryMaxPercent.toFixed(0)}%`}</strong><small>Minimum to maximum SOC</small></div>
        <div><span>Battery change</span><strong>{history?.summary.batteryStartPercent == null || history.summary.batteryEndPercent == null ? "—" : `${history.summary.batteryStartPercent.toFixed(0)} → ${history.summary.batteryEndPercent.toFixed(0)}%`}</strong><small>First to last stored reading</small></div>
        <div><span>Recorded coverage</span><strong>{history ? percent(history.coverage.percent) : "—"}</strong><small>{history ? `${history.coverage.samples.toLocaleString()} readings` : "Stored samples"}</small></div>
      </div>
    </article>

    <article className="card assumptions-card">
      <div className="card-heading"><div><p className="eyebrow">Dashboard settings</p><h2>Tariffs, capacity and investment</h2></div>{settings?.updatedAt && <small>Saved {new Date(settings.updatedAt).toLocaleDateString("en-PK")}</small>}</div>
      <p className="parameter-intro">Pre-filled from the iTel settings shown in your screenshots. These values are saved to your account and drive savings, load percentage and payback. Estimates exclude taxes, billing slabs, fixed fees and demand charges.</p>
      <div className="settings-form">
        <label><span>Grid import tariff</span><div><input inputMode="decimal" min="0" max="500" value={settingsDraft.importTariffPerKwh} onChange={(event) => setSettingsDraft({ ...settingsDraft, importTariffPerKwh: event.target.value })} placeholder="e.g. 65" /><small>PKR/kWh</small></div></label>
        <label><span>Export credit</span><div><input inputMode="decimal" min="0" max="500" value={settingsDraft.exportCreditPerKwh} onChange={(event) => setSettingsDraft({ ...settingsDraft, exportCreditPerKwh: event.target.value })} placeholder="Optional" /><small>PKR/kWh</small></div></label>
        <label><span>Inverter capacity</span><div><input inputMode="decimal" min="100" value={settingsDraft.inverterCapacityW} onChange={(event) => setSettingsDraft({ ...settingsDraft, inverterCapacityW: event.target.value })} /><small>watts</small></div></label>
        <label><span>Solar array capacity</span><div><input inputMode="decimal" min="100" value={settingsDraft.solarCapacityW} onChange={(event) => setSettingsDraft({ ...settingsDraft, solarCapacityW: event.target.value })} /><small>watts</small></div></label>
        <label><span>Grid export offset</span><div><input inputMode="decimal" min="0" value={settingsDraft.gridExportOffset} onChange={(event) => setSettingsDraft({ ...settingsDraft, gridExportOffset: event.target.value })} /><small>ratio</small></div></label>
        <label><span>Solar panel cost</span><div><input inputMode="decimal" min="0" value={settingsDraft.solarPanelCost} onChange={(event) => setSettingsDraft({ ...settingsDraft, solarPanelCost: event.target.value })} /><small>PKR</small></div></label>
        <label><span>Inverter + battery</span><div><input inputMode="decimal" min="0" value={settingsDraft.inverterBatteryCost} onChange={(event) => setSettingsDraft({ ...settingsDraft, inverterBatteryCost: event.target.value })} /><small>PKR</small></div></label>
        <label><span>Installation + fees</span><div><input inputMode="decimal" min="0" value={settingsDraft.installationCost} onChange={(event) => setSettingsDraft({ ...settingsDraft, installationCost: event.target.value })} /><small>PKR</small></div></label>
      </div>
      <div className="settings-actions"><button className="primary-button" onClick={() => void saveSettings()} disabled={savingSettings}>{savingSettings ? "Saving…" : "Save assumptions"}</button>{settingsMessage && <span>{settingsMessage}</span>}</div>
    </article>
  </>;
}
