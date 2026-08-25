import { NextResponse } from "next/server";
import { getChatGPTUser } from "../../../chatgpt-auth";
import { isLocalPreview } from "../../../request-origin";
import { credentialsForSite, listSites } from "../../../../lib/accounts";
import { discoverStationAndDevice, withItelAuth } from "../../../../lib/itel";

export const dynamic = "force-dynamic";

type WeatherPayload = {
  current?: {
    time: string; temperature_2m: number; apparent_temperature: number; relative_humidity_2m: number;
    is_day: number; precipitation: number; weather_code: number; cloud_cover: number;
    wind_speed_10m: number; shortwave_radiation: number;
  };
};

function finite(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function condition(code: number, cloudCover: number) {
  if ([95, 96, 99].includes(code)) return "Thunderstorm";
  if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return "Rain";
  if ([71, 73, 75, 77, 85, 86].includes(code)) return "Snow";
  if ([45, 48].includes(code)) return "Fog";
  if (cloudCover >= 75 || code === 3) return "Cloudy";
  if (cloudCover >= 35 || code === 2) return "Partly cloudy";
  return "Clear";
}

function themeFor(current: NonNullable<WeatherPayload["current"]>) {
  if (!current.is_day) return "night";
  if ([95, 96, 99, 51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].includes(current.weather_code)) return "rain";
  if (current.temperature_2m >= 32 || current.apparent_temperature >= 35) return "heat";
  if (current.temperature_2m <= 8) return "cold";
  if (current.cloud_cover >= 70 || [3, 45, 48].includes(current.weather_code)) return "cloud";
  return "clear";
}

export async function GET(request: Request) {
  const viewer = await getChatGPTUser();
  const local = isLocalPreview(new URL(request.url).hostname);
  if (!viewer && !local) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  try {
    let latitude = finite(process.env.SITE_LATITUDE);
    let longitude = finite(process.env.SITE_LONGITUDE);
    let location = "Configured site";
    let locationSource = latitude !== null && longitude !== null ? "configured" : "unavailable";
    const url = new URL(request.url);
    const requestedSite = url.searchParams.get("siteId");
    const userId = viewer?.userId ?? "local-preview";
    const known = await listSites(userId).catch(() => []);
    const target = requestedSite && requestedSite !== "all"
      ? known.find((site) => site.siteId === requestedSite)
      : known[0];
    if (requestedSite && requestedSite !== "all" && !target) {
      return NextResponse.json({ error: "That site does not belong to this account" }, { status: 404 });
    }
    if (target) {
      try {
        const credentials = await credentialsForSite(userId, target.siteId);
        const station = await withItelAuth(credentials.username, credentials.password, async (accessToken) => {
          const found = await discoverStationAndDevice(accessToken, credentials.username, credentials.stationId, credentials.deviceSn);
          return found.station;
        });
        const stationLat = finite(station?.latitude ?? station?.lat);
        const stationLng = finite(station?.longitude ?? station?.lng);
        location = target.displayName || station?.stationName || location;
        if (stationLat !== null && stationLng !== null) { latitude = stationLat; longitude = stationLng; locationSource = "iTel station"; }
      } catch { /* Weather remains available from the configured area when iTel metadata is unavailable. */ }
    }

    if (latitude === null || longitude === null) {
      return NextResponse.json(
        { error: "Weather location is unavailable. Configure SITE_LATITUDE and SITE_LONGITUDE or provide station coordinates." },
        { status: 503, headers: { "Cache-Control": "private, max-age=60" } },
      );
    }

    const query = new URLSearchParams({
      latitude: String(latitude), longitude: String(longitude), timezone: "auto", forecast_days: "1",
      current: "temperature_2m,apparent_temperature,relative_humidity_2m,is_day,precipitation,weather_code,cloud_cover,wind_speed_10m,shortwave_radiation",
    });
    const response = await fetch(`https://api.open-meteo.com/v1/forecast?${query}`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(12_000) });
    if (!response.ok) throw new Error(`Weather provider returned ${response.status}`);
    const payload = await response.json() as WeatherPayload;
    if (!payload.current) throw new Error("Weather provider returned no current conditions");
    const current = payload.current;
    const solarPotential = !current.is_day || current.shortwave_radiation < 20 ? "None" : current.shortwave_radiation < 180 ? "Low" : current.shortwave_radiation < 500 ? "Moderate" : "Strong";
    return NextResponse.json({
      location, locationSource, latitude, longitude, observedAt: current.time, theme: themeFor(current),
      condition: condition(current.weather_code, current.cloud_cover), temperatureC: current.temperature_2m,
      feelsLikeC: current.apparent_temperature, humidityPercent: current.relative_humidity_2m,
      isDay: Boolean(current.is_day), precipitationMm: current.precipitation, cloudCoverPercent: current.cloud_cover,
      windKph: current.wind_speed_10m, solarRadiationWm2: current.shortwave_radiation, solarPotential,
    }, { headers: { "Cache-Control": "private, max-age=600" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Weather is unavailable";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
