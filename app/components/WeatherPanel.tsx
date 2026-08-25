"use client";

import { useEffect, useState } from "react";

type Weather = {
  location: string; theme: string; condition: string; temperatureC: number; feelsLikeC: number;
  humidityPercent: number; windKph: number; cloudCoverPercent: number; solarRadiationWm2: number; solarPotential: string; isDay: boolean;
};

const GLYPH: Record<string, string> = { clear: "☀️", heat: "🔆", cloud: "⛅", rain: "🌧️", cold: "❄️", night: "🌙" };

/** Rich current-conditions panel with the solar-potential read the household cares about. */
export default function WeatherPanel() {
  const [wx, setWx] = useState<Weather | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = () => void fetch("/api/weather/current", { cache: "no-store", credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() as Promise<Weather> : null))
      .then((body) => { if (!cancelled && body) setWx(body); })
      .catch(() => undefined);
    load();
    const timer = window.setInterval(load, 15 * 60 * 1000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);

  if (!wx) return <article className="card weather-panel"><div className="weather-orb">🌡️</div><div><div className="wx-cond">Connecting to weather…</div></div></article>;
  return (
    <article className="card weather-panel" style={{ gridTemplateColumns: "auto 1fr", display: "block", padding: "18px 20px" }}>
      <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
        <div className="weather-orb">{GLYPH[wx.theme] ?? "🌡️"}</div>
        <div>
          <div className="wx-temp">{Math.round(wx.temperatureC)}°</div>
          <div className="wx-cond">{wx.condition} · {wx.location} · feels {Math.round(wx.feelsLikeC)}°</div>
        </div>
        <div style={{ marginLeft: "auto", textAlign: "right" }}>
          <div className="eyebrow" style={{ margin: 0 }}>Solar potential</div>
          <strong style={{ fontSize: 15 }}>{wx.solarPotential}</strong>
        </div>
      </div>
      <div className="wx-solar-bar" style={{ width: `${Math.min(100, wx.solarRadiationWm2 / 8.5)}%` }} />
      <div className="weather-metrics">
        <div><span>Solar</span><strong>{Math.round(wx.solarRadiationWm2)} W/m²</strong></div>
        <div><span>Humidity</span><strong>{Math.round(wx.humidityPercent)}%</strong></div>
        <div><span>Wind</span><strong>{Math.round(wx.windKph)} km/h</strong></div>
        <div><span>Cloud</span><strong>{Math.round(wx.cloudCoverPercent)}%</strong></div>
      </div>
    </article>
  );
}
