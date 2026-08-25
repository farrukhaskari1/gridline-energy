import { desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { isLocalPreview } from "../../../request-origin";
import { getChatGPTUser } from "../../../chatgpt-auth";
import { getD1, getDb } from "../../../../db";
import { auditLogs, devices, rawProviderEvents, sites, telemetry, users } from "../../../../db/schema";
// `stableId` used to be defined here as well. Two copies of an id-derivation
// rule is one copy too many: if they ever drift, adding an account and syncing
// it write two different site rows for the same inverter.
import { bootstrapFromEnvironment, credentialsForSite, deviceIdFor, listSites, siteIdFor } from "../../../../lib/accounts";
import { combineReadings, type SiteReading } from "../../../../lib/combine";
import { discoverStationAndDevice, getEnergyFlow, withItelAuth } from "../../../../lib/itel";
import { fetchSiteStat, periodKeysFor } from "../../../../lib/energy-rollup";

export const dynamic = "force-dynamic";

const MIN_SAMPLE_INTERVAL_SECONDS = 5;

type PollTarget = { siteId: string | null; username: string; password: string; stationId?: number; deviceSn?: string; label: string | null };

type PollResult = {
  siteId: string; deviceId: string; stationName: string; productModel?: string; label: string;
  batteryCapacityKWh: number | null;
  telemetry: {
    recordedAt: string; source: string;
    pvPowerW: number | null; loadPowerW: number | null; gridPowerW: number | null;
    batteryPowerW: number | null; batterySocPercent: number | null; generatorPowerW: number | null;
    online: boolean; reportTime: string | null; mqttStatus: number | null; timezone: string | null;
    generatedTodayKWh: number | null; consumedTodayKWh: number | null;
  };
  storageWarning?: string;
};

/**
 * Polls one inverter and stores the reading.
 *
 * Storage failures are contained per site: one inverter whose write fails must
 * not cost the other its live reading, which is why the whole persistence block
 * is inside its own try.
 */
async function pollSite(
  target: PollTarget,
  viewer: { userId: string; email: string; displayName: string | null },
  now: Date,
): Promise<PollResult> {
  const { station, device, flow, today } = await withItelAuth(target.username, target.password, async (accessToken) => {
    const found = await discoverStationAndDevice(accessToken, target.username, target.stationId, target.deviceSn);
    const liveFlow = await getEnergyFlow(accessToken, found.station.stationId, found.device.deviceSn);
    // Today's generated/consumed must match the provider's own "Today" cards
    // (Solar Generation / Home Usage). Those come from /v2/dashboard at
    // dimension=2 ("today") — the app's default dimension=1 is a multi-day
    // window and reads far higher, which is why the old figures did not match.
    // fetchSiteStat maps day→dimension 2 internally.
    const timezone = found.station.timeZone ?? found.station.timezone ?? "Asia/Karachi";
    const dayKey = periodKeysFor(timezone, now).day;
    const stat = await fetchSiteStat(accessToken, { stationId: found.station.stationId, deviceSn: found.device.deviceSn, categoryCode: found.device.categoryCode, dimension: "day", dateKey: dayKey, timeZone: timezone }).catch(() => null);
    return { ...found, flow: liveFlow, today: stat };
  });

  const siteId = target.siteId ?? await siteIdFor(viewer.userId, station.stationId);
  const deviceId = await deviceIdFor(siteId, device.deviceSn);
  const currentTelemetry = {
    recordedAt: now.toISOString(), source: "REST", pvPowerW: flow.pvPower ?? null, loadPowerW: flow.loadPower ?? null,
    gridPowerW: flow.gridPower ?? null, batteryPowerW: flow.batteryPower ?? null, batterySocPercent: flow.batterySoc ?? null,
    generatorPowerW: flow.genPower ?? null, online: flow.netStatus === 1, reportTime: flow.reportTime ?? null,
    mqttStatus: flow.mqttStatus ?? null, timezone: flow.timezone ?? null,
    generatedTodayKWh: today?.generationKwh ?? null, consumedTodayKWh: today?.consumptionKwh ?? null,
  };

  let storageWarning: string | undefined;
  let batteryCapacityKWh: number | null = null;
  try {
    const db = getDb();
    const previous = (await db.select({ loadPowerW: telemetry.loadPowerW, recordedAt: telemetry.recordedAt, online: telemetry.online }).from(telemetry).where(eq(telemetry.deviceId, deviceId)).orderBy(desc(telemetry.recordedAt)).limit(1))[0];
    await db.insert(users).values({ id: viewer.userId, email: viewer.email, displayName: viewer.displayName, createdAt: now, updatedAt: now }).onConflictDoUpdate({ target: users.id, set: { updatedAt: now } });
    await db.insert(sites).values({ id: siteId, userId: viewer.userId, providerStationId: String(station.stationId), name: station.stationName, timezone: station.timeZone ?? station.timezone ?? "Asia/Karachi", status: "online", createdAt: now })
      // Only provider-owned facts are refreshed here. The owner's display name,
      // ordering and visibility are theirs and a poll must not overwrite them.
      .onConflictDoUpdate({ target: sites.id, set: { name: station.stationName, status: "online" } });
    await db.insert(devices).values({ id: deviceId, siteId, providerDeviceSn: device.deviceSn, productModel: device.productModel, categoryCode: device.categoryCode, status: device.onlineStatus === 1 ? "online" : "unknown", lastSeenAt: now }).onConflictDoUpdate({ target: devices.id, set: { status: device.onlineStatus === 1 ? "online" : "unknown", lastSeenAt: now } });
    batteryCapacityKWh = (await db.select({ capacity: sites.batteryCapacityKWh }).from(sites).where(eq(sites.id, siteId)).limit(1))[0]?.capacity ?? null;

    const ageSeconds = previous?.recordedAt ? (now.getTime() - previous.recordedAt.getTime()) / 1000 : Infinity;
    // Every open browser tab polls independently. Without this guard two tabs
    // double the stored history and can report the same load change twice.
    const stored = await getD1().prepare(
      `INSERT INTO telemetry (site_id, device_id, recorded_at, source, pv_power_w, load_power_w, grid_power_w, battery_power_w, battery_soc_percent, generator_power_w, online)
       SELECT ?, ?, ?, 'REST', ?, ?, ?, ?, ?, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM telemetry WHERE device_id = ? AND recorded_at > ?)`
    ).bind(
      siteId, deviceId, Math.floor(now.getTime() / 1000), flow.pvPower ?? null, flow.loadPower ?? null,
      flow.gridPower ?? null, flow.batteryPower ?? null, flow.batterySoc ?? null, flow.genPower ?? null,
      flow.netStatus === 1 ? 1 : 0, deviceId, Math.floor(now.getTime() / 1000) - MIN_SAMPLE_INTERVAL_SECONDS,
    ).run();
    const sampleStored = Number(stored.meta.changes ?? 0) > 0;
    if (sampleStored) {
      await db.insert(rawProviderEvents).values({ siteId, source: "REST", topicOrPath: "/energy/appliance/app/v1/home/flow", payloadJson: JSON.stringify(flow), receivedAt: now });
      await db.insert(auditLogs).values({ userId: viewer.userId, action: "itel.sync", targetType: "site", targetId: siteId, detailJson: JSON.stringify({ source: "REST", success: true }), createdAt: now });
    }
    const currentLoad = typeof flow.loadPower === "number" ? flow.loadPower : null;
    const previousLoad = typeof previous?.loadPowerW === "number" ? previous.loadPowerW : null;
    if (sampleStored && currentLoad !== null && previousLoad !== null && previous.online && flow.netStatus === 1 && ageSeconds <= 90) {
      const deltaW = currentLoad - previousLoad;
      const thresholdW = Math.max(75, Math.max(Math.abs(currentLoad), Math.abs(previousLoad)) * .15);
      if (Math.abs(deltaW) >= thresholdW) {
        const confidence = Math.abs(deltaW) >= 500 ? "high" : Math.abs(deltaW) >= 200 ? "medium" : "low";
        await db.insert(auditLogs).values({
          userId: viewer.userId, action: deltaW > 0 ? "load.added" : "load.removed", targetType: "device", targetId: deviceId,
          detailJson: JSON.stringify({ beforeW: previousLoad, afterW: currentLoad, deltaW, thresholdW: Math.round(thresholdW), confidence, sampleWindowSeconds: Math.round(ageSeconds), stationName: station.stationName, siteId }), createdAt: now,
        });
      }
    }
  } catch {
    storageWarning = "Live reading received, but history storage is temporarily unavailable";
  }

  return {
    siteId, deviceId, stationName: station.stationName, productModel: device.productModel,
    label: target.label?.trim() || station.stationName, batteryCapacityKWh,
    telemetry: currentTelemetry, storageWarning,
  };
}

export async function POST(request: Request) {
  const url = new URL(request.url);
  const viewer = await getChatGPTUser();
  const isLocal = isLocalPreview(url.hostname);
  if (!viewer && !isLocal) return NextResponse.json({ error: "Authentication required" }, { status: 401 });

  const identity = {
    userId: viewer?.userId ?? "local-preview",
    email: viewer?.email ?? "local@gridline.invalid",
    displayName: viewer?.displayName ?? "Local owner",
  };
  const requestedSite = url.searchParams.get("siteId");
  const wantsCombined = requestedSite === null || requestedSite === "" || requestedSite === "all";

  try {
    await bootstrapFromEnvironment(identity.userId, identity.email, identity.displayName);
    const known = await listSites(identity.userId, { includeHidden: true }).catch(() => []);
    if (!wantsCombined && !known.some((site) => site.siteId === requestedSite)) {
      return NextResponse.json({ connected: false, error: "That site does not belong to this account" }, { status: 404 });
    }
    const chosen = wantsCombined ? known.filter((site) => !site.hidden) : known.filter((site) => site.siteId === requestedSite);

    let targets: PollTarget[];
    let credentialFailures: Array<{ siteId: string; label: string; error: string }> = [];
    if (chosen.length > 0) {
      const resolved = await Promise.all(chosen.map(async (site) => {
        try {
          const credentials = await credentialsForSite(identity.userId, site.siteId);
          return { ok: true as const, target: { siteId: site.siteId, label: site.displayName, ...credentials } };
        } catch (error) {
          return { ok: false as const, failure: { siteId: site.siteId, label: site.displayName, error: error instanceof Error ? error.message : "Credentials are unavailable" } };
        }
      }));
      targets = resolved.filter((entry) => entry.ok).map((entry) => entry.target);
      credentialFailures = resolved.filter((entry) => !entry.ok).map((entry) => entry.failure);
    } else if (known.length === 0) {
      // No registered site yet — the very first poll of a fresh deployment.
      // Fall back to the environment so the portal works before anyone has
      // added an account through the UI.
      const username = process.env.ITEL_USERNAME, password = process.env.ITEL_PASSWORD;
      if (!username || !password) return NextResponse.json({ connected: false, error: "iTel credentials have not been configured" }, { status: 409 });
      targets = [{ siteId: null, username, password, label: null }];
    } else {
      // Registered sites exist but the owner hid every one. Treat that as an
      // empty selection: falling back to the environment here would recreate
      // or poll an inverter the owner deliberately removed from the portal.
      return NextResponse.json({ connected: false, error: "No visible sites are selected", failures: [] }, { status: 409 });
    }

    const now = new Date();
    const settled = await Promise.all(targets.map(async (target) => {
      try {
        return { ok: true as const, value: await pollSite(target, identity, now) };
      } catch (error) {
        // One unreachable inverter must not blank the other. The failure is
        // reported alongside the readings that did arrive.
        return { ok: false as const, siteId: target.siteId, label: target.label, error: error instanceof Error ? error.message : "Unknown synchronization failure" };
      }
    }));

    const results = settled.filter((entry) => entry.ok).map((entry) => entry.value);
    const failures = [...credentialFailures, ...settled.filter((entry) => !entry.ok).map((entry) => ({ siteId: entry.siteId, label: entry.label, error: entry.error }))];
    if (results.length === 0) {
      return NextResponse.json({ connected: false, error: failures[0]?.error ?? "Unknown synchronization failure", failures }, { status: 502 });
    }

    const readings: SiteReading[] = results.map((result) => ({
      siteId: result.siteId, label: result.label,
      batteryCapacityKWh: result.batteryCapacityKWh ?? 1,
      recordedAt: now.getTime(),
      telemetry: {
        pvPowerW: result.telemetry.pvPowerW, loadPowerW: result.telemetry.loadPowerW,
        gridPowerW: result.telemetry.gridPowerW, batteryPowerW: result.telemetry.batteryPowerW,
        batterySocPercent: result.telemetry.batterySocPercent, generatorPowerW: result.telemetry.generatorPowerW,
        loadPercent: null, inputVoltage: null, temperatureC: null,
        generatedTodayKWh: result.telemetry.generatedTodayKWh, consumedTodayKWh: result.telemetry.consumedTodayKWh,
        online: result.telemetry.online,
      },
    }));
    const combined = combineReadings(readings, { now: now.getTime() });
    const headline = results.length === 1 ? results[0].telemetry : {
      ...results[0].telemetry,
      pvPowerW: combined?.telemetry.pvPowerW ?? null, loadPowerW: combined?.telemetry.loadPowerW ?? null,
      gridPowerW: combined?.telemetry.gridPowerW ?? null, batteryPowerW: combined?.telemetry.batteryPowerW ?? null,
      batterySocPercent: combined?.telemetry.batterySocPercent ?? null, generatorPowerW: combined?.telemetry.generatorPowerW ?? null,
      generatedTodayKWh: combined?.telemetry.generatedTodayKWh ?? null, consumedTodayKWh: combined?.telemetry.consumedTodayKWh ?? null,
      online: combined?.telemetry.online ?? false,
      recordedAt: null, reportTime: null, mqttStatus: null, timezone: null,
    };
    const primary = results[0];

    return NextResponse.json({
      connected: true,
      // Kept flat and singular so every existing reader keeps working: with one
      // inverter these are that inverter, with several they are the household.
      station: { id: results.length === 1 ? primary.siteId : "all", name: results.length === 1 ? primary.stationName : "All inverters" },
      device: { id: primary.deviceId, model: primary.productModel },
      telemetry: headline,
      siteId: wantsCombined ? "all" : requestedSite,
      siteCount: results.length,
      incomplete: (combined?.incomplete ?? false) || failures.length > 0,
      sites: results.map((result) => ({
        siteId: result.siteId, label: result.label, stationName: result.stationName,
        model: result.productModel, batteryCapacityKWh: result.batteryCapacityKWh,
        telemetry: result.telemetry, storageWarning: result.storageWarning,
      })),
      failures,
      storageWarning: results.find((result) => result.storageWarning)?.storageWarning,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown synchronization failure";
    return NextResponse.json({ connected: false, error: message }, { status: 502 });
  }
}
