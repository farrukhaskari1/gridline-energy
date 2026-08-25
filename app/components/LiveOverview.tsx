"use client";

import type { CSSProperties } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { publishReading } from "./EnergyAtmosphere";
import { WeatherChip } from "./WeatherTheme";
import { solarState } from "../../lib/solar-state";
import { SiteSelector } from "./SiteSelector";
import { useSiteSelection, withSite } from "./site-selection";

const navItems = [
  { label: "Overview", href: "/" }, { label: "Energy", href: "/energy" }, { label: "Devices", href: "/devices" },
  { label: "Automations", href: "/automations" }, { label: "Activity", href: "/activity" },
];

type LiveData = {
  connected: boolean;
  station?: { name?: string };
  device?: { model?: string };
  telemetry?: {
    pvPowerW?: number | null; loadPowerW?: number | null; gridPowerW?: number | null;
    batteryPowerW?: number | null; batterySocPercent?: number | null; generatorPowerW?: number | null;
    online?: boolean; reportTime?: string | null; mqttStatus?: number | null; timezone?: string | null;
    generatedTodayKWh?: number | null; consumedTodayKWh?: number | null;
  };
  error?: string;
};

type SystemSettings = { inverterCapacityW: number; solarCapacityW: number };

function numeric(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatPower(value: number | null | undefined) {
  const watts = numeric(value);
  if (watts === null) return "—";
  return Math.abs(watts) >= 1000 ? `${watts / 1000} kW` : `${watts} W`;
}

function formatUnits(value: number | null | undefined) {
  const units = numeric(value);
  return units === null ? "—" : `${units} units`;
}

function timeAgo(lastSync: number | null, now: number) {
  if (!lastSync) return "Waiting for first reading";
  const seconds = Math.max(0, Math.floor((now - lastSync) / 1000));
  return seconds < 2 ? "Updated now" : `Updated ${seconds} sec ago`;
}

function flowDuration(value: number | null) {
  if (value === null || Math.abs(value) < 1) return "3.2s";
  return `${Math.max(.8, Math.min(2.8, 2.9 - Math.log10(Math.abs(value) + 1) * .62)).toFixed(2)}s`;
}

function loadExperience(utilization: number | null) {
  if (utilization === null) return { label: "Waiting", detail: "A live load reading has not arrived." };
  if (utilization < 15) return { label: "Very light", detail: "Only a small part of inverter capacity is in use." };
  if (utilization < 40) return { label: "Light", detail: "The home is running comfortably below capacity." };
  if (utilization < 70) return { label: "Normal", detail: "Demand is active with useful capacity still available." };
  if (utilization < 90) return { label: "Heavy", detail: "Large appliances may be running together." };
  return { label: "Near limit", detail: "Demand is close to or above the configured inverter rating." };
}

function reserveExperience(battery: number | null) {
  if (battery === null) return { label: "Unknown reserve", detail: "Battery state is not available." };
  if (battery >= 80) return { label: "Strong reserve", detail: "The battery is well charged for an interruption." };
  if (battery >= 50) return { label: "Healthy reserve", detail: "Useful backup charge is available." };
  if (battery >= 25) return { label: "Limited reserve", detail: "Backup charge is below half." };
  return { label: "Low reserve", detail: "Battery charge is low; avoid unnecessary heavy loads." };
}

export default function LiveOverview() {
  const { siteId } = useSiteSelection();
  const [data, setData] = useState<LiveData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [lastSync, setLastSync] = useState<number | null>(null);
  const [now, setNow] = useState(0);
  const [settings, setSettings] = useState<SystemSettings>({ inverterCapacityW: 4000, solarCapacityW: 4680 });
  const inFlight = useRef(false);

  const sync = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setRefreshing(true);
    try {
      const response = await fetch(withSite("/api/itel/sync", siteId), { method: "POST", cache: "no-store", credentials: "same-origin" });
      const payload = await response.json() as LiveData;
      if (!response.ok || !payload.connected) throw new Error(payload.error || "The iTel collector did not return a live reading");
      setData(payload);
      setError(null);
      setLastSync(Date.now());
      // Let the rest of the site colour itself from this reading rather than
      // polling the provider again on every page.
      publishReading(payload);
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : "Live data is unavailable");
    } finally {
      inFlight.current = false;
      setRefreshing(false);
    }
  }, [siteId]);

  useEffect(() => {
    const initial = window.setTimeout(() => void sync(), 0);
    const syncTimer = window.setInterval(() => void sync(), 10_000);
    const clockTimer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => { window.clearTimeout(initial); window.clearInterval(syncTimer); window.clearInterval(clockTimer); };
  }, [sync]);

  useEffect(() => {
    void fetch(withSite("/api/settings/energy", siteId), { cache: "no-store", credentials: "same-origin" })
      .then((response) => response.ok ? response.json() : null)
      .then((result: SystemSettings | null) => { if (result) setSettings(result); })
      .catch(() => undefined);
  }, [siteId]);

  const telemetry = data?.telemetry;
  const load = numeric(telemetry?.loadPowerW);
  const solar = numeric(telemetry?.pvPowerW);
  const grid = numeric(telemetry?.gridPowerW);
  const batteryPower = numeric(telemetry?.batteryPowerW);
  const battery = numeric(telemetry?.batterySocPercent);
  const generator = numeric(telemetry?.generatorPowerW);
  const generatedToday = numeric(telemetry?.generatedTodayKWh);
  const consumedToday = numeric(telemetry?.consumedTodayKWh);
  // Solar can produce more than the house is using, but it cannot *cover* more
  // than all of demand — the excess is charging the battery or going to the
  // grid. Reporting the raw ratio here is what produced "covering 108% of
  // demand". Coverage is clamped; the surplus is reported separately so the
  // information is not lost.
  const solarRatio = load && solar !== null ? Math.max(0, (solar / load) * 100) : null;
  const coverage = solarRatio === null ? null : Math.min(100, Math.round(solarRatio));
  const solarSurplus = load !== null && solar !== null ? Math.max(0, solar - load) : null;
  const loadUtilization = load === null ? null : Math.max(0, load / settings.inverterCapacityW * 100);
  const solarUtilization = solar === null ? null : Math.max(0, solar / settings.solarCapacityW * 100);
  const gridShare = load && grid !== null ? Math.abs(grid) / load * 100 : null;
  const isLive = Boolean(data?.connected && !error && lastSync && now - lastSync <= 30_000);
  const batteryLevel = battery === null ? 0 : Math.min(100, Math.max(0, battery));
  const batterySupplying = batteryPower !== null && batteryPower > 30;
  const batteryCharging = batteryPower !== null && batteryPower < -30;
  // Shares its thresholds with the Swift `SolarState` so the browser and the
  // apps cannot disagree about whether the panels are working.
  const solarPhase = solarState(solar);
  const solarActive = solarPhase !== "idle";
  const gridActive = grid !== null && Math.abs(grid) >= 5;
  const batteryActive = batteryPower !== null && Math.abs(batteryPower) >= 30;
  const homeActive = load !== null && Math.abs(load) >= 5;
  const batteryState = batterySupplying ? "Supplying home" : batteryCharging ? "Charging" : batteryPower === null ? "Waiting" : "Idle";
  const batteryStatePower = batteryPower === null ? "—" : formatPower(Math.abs(batteryPower));
  const balanceMax = Math.max(1, load ?? 0, solar ?? 0, Math.abs(grid ?? 0));
  const homeExperience = loadExperience(loadUtilization);
  const reserve = reserveExperience(battery);
  const headroom = loadUtilization === null ? null : Math.max(0, 100 - loadUtilization);
  const solarRole = coverage === null ? "Waiting for solar" : coverage >= 100 ? "Covering all demand" : coverage >= 60 ? "Carrying most demand" : coverage >= 20 ? "Helping the grid" : "Small contribution";
  const sourceStory = load === null ? "Waiting for a live picture of your home." : solar !== null && load > 0 && solar >= load
    ? `Solar is producing enough for the home's current ${formatPower(load)} demand${grid !== null && grid < 0 ? " and excess power is going to the grid." : "."}`
    : batterySupplying ? `The home is using ${formatPower(load)}, with the battery actively supplying ${batteryStatePower}.`
    : grid !== null && grid > 5 ? `The home is using ${formatPower(load)}, with ${formatPower(grid)} currently coming from the grid.`
    : `The home is using ${formatPower(load)} with little or no grid import right now.`;

  return (
    <main className={`app-shell ${refreshing ? "is-syncing" : ""}`}>
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">G</span><span>Gridline</span></div>
        <nav aria-label="Main navigation">{navItems.map((item, index) => <a className={index === 0 ? "nav-item active" : "nav-item"} href={withSite(item.href, siteId)} key={item.label} style={{ "--nav-index": index } as CSSProperties}><span className="nav-dot" />{item.label}</a>)}</nav>
        <div className="sidebar-foot"><div className={`signal ${isLive ? "" : "offline"}`}><span /> {isLive ? "Collector online" : "Collector connecting"}</div><p>{timeAgo(lastSync, now)}</p></div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div><p className="eyebrow">Home energy</p><h1>Good evening, John.</h1></div>
          <div className="top-actions"><WeatherChip /><SiteSelector /><button className="avatar" aria-label="Open account menu">JK</button></div>
        </header>

        <div className={`status-strip ${error ? "error" : ""}`} aria-live="polite">
          <span className="refresh-progress" key={`progress-${lastSync}`} />
          <span className={`live-pill ${isLive ? "" : "connecting"}`}><i /> {isLive ? "Live" : error ? "Stale" : "Connecting"}</span>
          <p>{error ? <>The last live reading is shown. <strong>{error}</strong></> : load === null ? "Connecting securely to your iTel Energy system…" : <>Your home is drawing <strong>{formatPower(load)}</strong>{coverage === null ? "." : <> with solar covering {coverage}% of demand{solarSurplus !== null && solarSurplus > 5 ? <>, and {formatPower(solarSurplus)} spare going to the battery or grid</> : null}.</>}</>}</p>
          <span className="updated">{timeAgo(lastSync, now)}</span>
        </div>

        <div className="dashboard-grid">
          <article className="card energy-card">
            <div className="card-heading"><div><p className="eyebrow">Live power</p><h2>Energy flow</h2></div><button className="quiet-button" onClick={() => void sync()} disabled={refreshing}><span className={`refresh-icon ${refreshing ? "spinning" : ""}`}>↻</span>{refreshing ? "Syncing" : "Refresh"}</button></div>
            <div className={`energy-flow ${isLive ? "is-live" : ""}`} aria-label="Live energy flow diagram" style={{ "--solar-speed": flowDuration(solar), "--grid-speed": flowDuration(grid), "--battery-speed": flowDuration(batteryPower) } as CSSProperties}>
              <div className="flow-aura" />
              <div className={`flow-line solar-line ${solarActive ? "is-active" : ""} ${solarPhase === "low" ? "is-low" : ""}`}><span /><b /></div>
              <div className={`flow-line grid-line ${gridActive ? "is-active" : ""} ${grid !== null && grid < 0 ? "is-reverse" : ""}`}><span /><b /></div>
              <div className={`flow-line battery-line ${batteryActive ? "is-active" : ""} ${batteryCharging ? "is-reverse" : ""} ${batterySupplying ? "is-supplying" : ""}`}><span /><b /></div>
              <div className={`flow-node solar-node ${solarActive ? "is-active" : ""}`}><span className="node-symbol sun-symbol">SOL</span><small>Solar</small><strong className="metric-reading" key={`solar-${lastSync}`}>{formatPower(solar)}</strong></div>
              <div className={`flow-node home-node ${homeActive ? "is-active" : ""}`}><span className="home-glyph"><i /></span><small>Home load</small><strong className="metric-reading hero-reading" key={`load-${lastSync}`}>{formatPower(load)}</strong></div>
              <div className={`flow-node grid-node ${gridActive ? "is-active" : ""}`}><span className="node-symbol grid-symbol">AC</span><small>{grid !== null && grid < 0 ? "Grid export" : "Grid import"}</small><strong className="metric-reading" key={`grid-${lastSync}`}>{formatPower(grid === null ? null : Math.abs(grid))}</strong></div>
              <div className={`flow-node battery-node ${batteryActive ? "is-active" : ""}`}><span className={`battery-glyph ${batterySupplying ? "is-supplying" : batteryCharging ? "is-charging" : ""}`}><i /></span><small>Battery · {batteryState}</small><strong className="metric-reading" key={`battery-${lastSync}`}>{battery === null ? batteryStatePower : `${battery}% · ${batteryStatePower}`}</strong></div>
            </div>
            <div className="today-energy" aria-label="Today's cumulative energy">
              <div><span><i className="solar-key" />Generated today</span><strong>{formatUnits(generatedToday)}</strong><small>kWh from solar</small></div>
              <div><span><i className="load-key" />Consumed today</span><strong>{formatUnits(consumedToday)}</strong><small>kWh used by home</small></div>
            </div>
          </article>

          <article className="card reserve-card">
            <div className="card-heading compact"><div><p className="eyebrow">Battery · {batteryState}</p><h2>{batteryStatePower}</h2></div><span className={`status-badge ${batterySupplying ? "battery-use" : batteryCharging ? "battery-charge" : ""}`}>{telemetry?.online === false ? "Offline" : batteryState}</span></div>
            <div className="battery-ring" style={{ "--level": `${batteryLevel}%` } as CSSProperties}><div><strong className="metric-reading" key={`ring-${lastSync}`}>{battery === null ? "—" : `${battery}%`}</strong><span>charged</span></div><i className="ring-orbit" /></div>
            <div className="reserve-stats"><div><span>Device</span><strong>{data?.device?.model || "—"}</strong></div><div><span>Source</span><strong>iTel REST</strong></div></div>
          </article>

          <article className="card chart-card current-balance-card">
            <div className="card-heading"><div><p className="eyebrow">Right now</p><h2>Current power balance</h2></div><a className="quiet-link" href="/energy">Open history →</a></div>
            <p className="balance-explainer">Instantaneous power, shown on one common scale. Energy totals and period comparisons live in Energy intelligence.</p>
            <div className="balance-rows">
              <div><span><i className="load-key" />Demand</span><b><i style={{ "--share": `${(load ?? 0) / balanceMax * 100}%` } as CSSProperties} /></b><strong>{formatPower(load)}</strong></div>
              <div><span><i className="solar-key" />Solar</span><b><i style={{ "--share": `${(solar ?? 0) / balanceMax * 100}%` } as CSSProperties} /></b><strong>{formatPower(solar)}</strong></div>
              <div><span><i className="grid-balance-key" />{grid !== null && grid < 0 ? "Grid export" : "Grid import"}</span><b><i style={{ "--share": `${Math.abs(grid ?? 0) / balanceMax * 100}%` } as CSSProperties} /></b><strong>{formatPower(grid === null ? null : Math.abs(grid))}</strong></div>
            </div>
          </article>

          <article className="card insight-card">
            <p className="eyebrow">Live collector</p><div className="insight-icon"><strong>10</strong><span>sec</span></div><h2>{isLive ? "Your readings are current" : "Connecting to iTel"}</h2>
            <p>The dashboard polls iTel every 10 seconds and stores each successful response for future charts, logs, and automations.</p><button className="primary-button" onClick={() => void sync()} disabled={refreshing}>Refresh live data</button>
          </article>
        </div>

        <article className="card reality-card">
          <div className="reality-copy"><p className="eyebrow">Right now, in plain English</p><h2>{sourceStory}</h2><p>These descriptions translate the current readings into household meaning. They update with every collector response and use your configured system capacity.</p></div>
          <div className="reality-grid">
            <div><span>Home pace</span><strong>{homeExperience.label}</strong><small>{homeExperience.detail}</small></div>
            <div><span>Solar role</span><strong>{solarRole}</strong><small>{coverage === null ? "Waiting for demand and solar." : `${coverage}% of current demand is matched by solar output.`}</small></div>
            <div><span>Inverter comfort</span><strong>{headroom === null ? "Unknown" : `${headroom.toFixed(0)}% headroom`}</strong><small>{loadUtilization === null ? "Waiting for load." : `${loadUtilization.toFixed(1)}% of configured capacity is in use.`}</small></div>
            <div><span>Outage readiness</span><strong>{reserve.label}</strong><small>{reserve.detail} Runtime needs battery capacity and load data.</small></div>
          </div>
        </article>

        <article className="card parameter-card live-parameter-card">
          <div className="card-heading"><div><p className="eyebrow">Full iTel response</p><h2>Live parameters</h2></div><span className={`status-badge ${isLive ? "" : "offline"}`}>{isLive ? "Current" : "Last known"}</span></div>
          <p className="parameter-intro">Raw readings come directly from the iTel flow response. Calculated percentages use the configured inverter and solar capacities.</p>
          <div className="parameter-section-label">Raw measurements</div>
          <div className="parameter-grid live-parameters">
            <div><span>Solar power</span><strong>{formatPower(solar)}</strong><small>pvPower</small></div>
            <div><span>Home load</span><strong>{formatPower(load)}</strong><small>loadPower</small></div>
            <div><span>Grid power (signed)</span><strong>{formatPower(grid)}</strong><small>gridPower · negative is export</small></div>
            <div><span>Battery power (signed)</span><strong>{formatPower(batteryPower)}</strong><small>batteryPower · provider sign</small></div>
            <div><span>Battery role</span><strong>{batteryState}</strong><small>{batterySupplying ? `${batteryStatePower} flowing to home` : batteryCharging ? `${batteryStatePower} flowing into battery` : "No material battery flow"}</small></div>
            <div><span>Battery state</span><strong>{battery === null ? "—" : `${battery}%`}</strong><small>batterySoc</small></div>
            <div><span>Generator power</span><strong>{formatPower(generator)}</strong><small>genPower</small></div>
            <div><span>Generated today</span><strong>{formatUnits(generatedToday)}</strong><small>pvDischarge · kWh</small></div>
            <div><span>Consumed today</span><strong>{formatUnits(consumedToday)}</strong><small>loadRecharge · kWh</small></div>
            <div><span>Network status</span><strong>{telemetry?.online === undefined ? "—" : telemetry.online ? "Online" : "Offline"}</strong><small>netStatus</small></div>
            <div><span>MQTT status</span><strong>{telemetry?.mqttStatus == null ? "—" : telemetry.mqttStatus === 1 ? "Connected" : `Code ${telemetry.mqttStatus}`}</strong><small>mqttStatus</small></div>
            <div><span>Provider report time</span><strong>{telemetry?.reportTime || "—"}</strong><small>reportTime</small></div>
            <div><span>Provider timezone</span><strong>{telemetry?.timezone || "—"}</strong><small>timezone</small></div>
            <div><span>Collector cadence</span><strong>10 sec</strong><small>REST polling interval</small></div>
          </div>
          <div className="parameter-section-label">Calculated meaning</div>
          <div className="parameter-grid live-parameters derived-parameters">
            <div><span>Load percentage</span><strong>{loadUtilization === null ? "—" : `${loadUtilization.toFixed(1)}%`}</strong><small>Load ÷ {formatPower(settings.inverterCapacityW)}</small></div>
            <div><span>Solar capacity used</span><strong>{solarUtilization === null ? "—" : `${solarUtilization.toFixed(1)}%`}</strong><small>Solar ÷ {formatPower(settings.solarCapacityW)}</small></div>
            <div><span>Solar demand coverage</span><strong>{coverage === null ? "—" : `${coverage}%`}</strong><small>Solar ÷ load, capped at 100%</small></div>
            <div><span>Solar surplus</span><strong>{solarSurplus === null ? "—" : formatPower(solarSurplus)}</strong><small>Solar beyond current demand</small></div>
            <div><span>Grid share of load</span><strong>{gridShare === null ? "—" : `${gridShare.toFixed(1)}%`}</strong><small>Absolute grid power ÷ load</small></div>
            <div><span>Reading freshness</span><strong>{lastSync ? `${Math.max(0, Math.floor((now - lastSync) / 1000))} sec` : "—"}</strong><small>Since collector response</small></div>
            <div><span>Source transport</span><strong>REST</strong><small>Not a WebSocket stream</small></div>
          </div>
        </article>
      </section>
    </main>
  );
}
