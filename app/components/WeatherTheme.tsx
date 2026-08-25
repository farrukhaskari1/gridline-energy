"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { useSiteSelection, withSite } from "./site-selection";

type Weather = {
  location: string; observedAt: string; theme: "clear" | "cloud" | "rain" | "heat" | "cold" | "night";
  condition: string; temperatureC: number; feelsLikeC: number; humidityPercent: number; isDay: boolean;
  precipitationMm: number; cloudCoverPercent: number; windKph: number; solarRadiationWm2: number; solarPotential: string;
};

const WeatherContext = createContext<Weather | null>(null);

export function WeatherThemeProvider({ children }: { children: React.ReactNode }) {
  const { siteId } = useSiteSelection();
  const [weather, setWeather] = useState<Weather | null>(null);
  useEffect(() => {
    let active = true;
    async function refresh() {
      try {
        const response = await fetch(withSite("/api/weather/current", siteId), { cache: "no-store", credentials: "same-origin" });
        if (!response.ok) return;
        const next = await response.json() as Weather;
        if (active) setWeather(next);
      } catch { /* The neutral theme remains readable when weather is temporarily unavailable. */ }
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15 * 60 * 1000);
    return () => { active = false; window.clearInterval(timer); };
  }, [siteId]);

  useEffect(() => {
    if (!weather) return;
    document.documentElement.dataset.weatherTheme = weather.theme;
    document.documentElement.style.setProperty("--solar-intensity", String(Math.min(1, Math.max(0, weather.solarRadiationWm2 / 850))));
    return () => { delete document.documentElement.dataset.weatherTheme; document.documentElement.style.removeProperty("--solar-intensity"); };
  }, [weather]);

  return <WeatherContext.Provider value={weather}><div className="weather-atmosphere" aria-hidden="true" />{children}</WeatherContext.Provider>;
}

export function WeatherChip() {
  const weather = useContext(WeatherContext);
  if (!weather) return <div className="weather-chip loading"><span className="weather-mark" /><div><strong>Weather</strong><small>Connecting…</small></div></div>;
  return <div className="weather-chip" title={`${weather.condition}. Feels like ${Math.round(weather.feelsLikeC)}°C. Humidity ${Math.round(weather.humidityPercent)}%. Wind ${Math.round(weather.windKph)} km/h.`}>
    <span className="weather-mark" />
    <div><strong>{Math.round(weather.temperatureC)}°</strong><small>{weather.condition}</small></div>
    <i><b>{Math.round(weather.solarRadiationWm2)}</b><small>W/m² solar</small></i>
  </div>;
}
