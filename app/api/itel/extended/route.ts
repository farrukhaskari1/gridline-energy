import { NextResponse } from "next/server";
import { isLocalPreview } from "../../../request-origin";
import { getChatGPTUser } from "../../../chatgpt-auth";
import { credentialsForSite, listSites } from "../../../../lib/accounts";
import { discoverStationAndDevice, getExtendedDeviceData, withItelAuth } from "../../../../lib/itel";

export const dynamic = "force-dynamic";

function readable(key: string) {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function flatten(value: unknown, prefix = "", output: Array<{ key: string; label: string; value: string | number | boolean }> = []) {
  if (output.length >= 120 || value === null || value === undefined) return output;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    if (prefix && !/token|password|secret|longitude|latitude|device.?sn|user.?id/i.test(prefix)) output.push({ key: prefix, label: readable(prefix.split(".").at(-1) || prefix), value });
    return output;
  }
  if (Array.isArray(value)) value.slice(0, 30).forEach((item, index) => flatten(item, `${prefix}[${index}]`, output));
  else if (typeof value === "object") Object.entries(value as Record<string, unknown>).forEach(([key, item]) => flatten(item, prefix ? `${prefix}.${key}` : key, output));
  return output;
}

export async function GET(request: Request) {
  const viewer = await getChatGPTUser();
  if (!viewer && !isLocalPreview(new URL(request.url).hostname)) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  const url = new URL(request.url);
  const requestedSite = url.searchParams.get("siteId");
  try {
    const userId = viewer?.userId ?? "local-preview";
    // Device detail is inherently per-inverter: there is no sensible way to
    // combine two inverters' firmware readouts, so this route always resolves a
    // single site — the one asked for, or the first visible one.
    const sites = await listSites(userId).catch(() => []);
    const target = requestedSite && requestedSite !== "all" ? sites.find((site) => site.siteId === requestedSite) : sites[0];
    if (requestedSite && requestedSite !== "all" && !target) return NextResponse.json({ error: "That site does not belong to this account" }, { status: 404 });

    let username: string, password: string, stationId: number | undefined, deviceSn: string | undefined;
    if (target) {
      ({ username, password, stationId, deviceSn } = await credentialsForSite(userId, target.siteId));
    } else {
      const envUsername = process.env.ITEL_USERNAME, envPassword = process.env.ITEL_PASSWORD;
      if (!envUsername || !envPassword) throw new Error("iTel credentials are not configured");
      username = envUsername; password = envPassword;
    }

    const { station, device, provider } = await withItelAuth(username, password, async (accessToken) => {
      const found = await discoverStationAndDevice(accessToken, username, stationId, deviceSn);
      const data = await getExtendedDeviceData(accessToken, found.station.stationId, found.device.deviceSn, found.device.categoryCode);
      return { ...found, provider: data };
    });
    const sections = Object.entries(provider).map(([key, result]) => ({ key, title: readable(key), fields: result.data === undefined ? [] : flatten(result.data), error: result.error ?? null }));
    return NextResponse.json({ siteId: target?.siteId ?? null, siteName: target?.displayName ?? station.stationName, station: station.stationName, device: { model: device.productModel, status: device.onlineStatus === 1 ? "online" : "unknown" }, sections }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Detailed iTel data is unavailable" }, { status: 502 });
  }
}
