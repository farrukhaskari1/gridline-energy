/**
 * Provider ingestion core, usable from both an API route and a scheduled cron.
 * Deliberately free of any `next/server` import so the Worker's `scheduled()`
 * handler can call it without pulling the request runtime in.
 */
import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { alerts, providerAccounts, sites } from "../db/schema";
import { bootstrapFromEnvironment, credentialsForSite, listSites, stableId } from "./accounts";
import { discoverStationAndDevice, getAlarms, getStationBatteryCapacityKwh, withItelAuth, type ItelAlarm } from "./itel";
import { ingestHousehold, ingestSite, type SiteIngestResult } from "./energy-rollup";

export type Identity = { userId: string; email: string; displayName: string | null };

export async function ingestForUser(identity: Identity) {
  const now = new Date();
  await bootstrapFromEnvironment(identity.userId, identity.email, identity.displayName);
  const known = await listSites(identity.userId, { includeHidden: false }).catch(() => []);
  const db = getDb();

  const settled = await Promise.all(known.map(async (site) => {
    try {
      const credentials = await credentialsForSite(identity.userId, site.siteId);
      const outcome = await withItelAuth(credentials.username, credentials.password, async (accessToken) => {
        const found = await discoverStationAndDevice(accessToken, credentials.username, credentials.stationId, credentials.deviceSn);
        const stats = await ingestSite(accessToken, {
          userId: identity.userId, siteId: site.siteId, stationId: found.station.stationId, device: found.device, timezone: site.timezone,
        }, now);

        let capacityFilled: number | null = null;
        if (site.batteryCapacityKWh === null) {
          const capacity = await getStationBatteryCapacityKwh(accessToken, found.station.stationId, found.device.deviceSn);
          if (capacity && capacity > 0 && capacity <= 1000) {
            await db.update(sites).set({ batteryCapacityKWh: capacity }).where(eq(sites.id, site.siteId));
            capacityFilled = capacity;
          }
        }

        let alarmsStored = 0;
        const providerAlarms = await getAlarms(accessToken, found.station.stationId, found.device.deviceSn).catch(() => [] as ItelAlarm[]);
        for (const alarm of providerAlarms.slice(0, 100)) {
          const occurredAt = alarm.occurredAt ? new Date(alarm.occurredAt) : now;
          const when = Number.isFinite(occurredAt.getTime()) ? occurredAt : now;
          const alertId = await stableId("alert", `${site.siteId}:${alarm.id ?? alarm.title}:${when.getTime()}`);
          await db.insert(alerts).values({
            id: alertId, siteId: site.siteId, severity: alarm.severity, title: alarm.title, message: alarm.message ?? null, occurredAt: when,
          }).onConflictDoNothing();
          alarmsStored += 1;
        }
        return { stats, capacityFilled, alarmsStored };
      });
      return { ok: true as const, siteId: site.siteId, label: site.displayName, timezone: site.timezone, ...outcome };
    } catch (error) {
      return { ok: false as const, siteId: site.siteId, label: site.displayName, error: error instanceof Error ? error.message : "Ingestion failed" };
    }
  }));

  const succeeded = settled.filter((entry): entry is Extract<typeof entry, { ok: true }> => entry.ok);
  const failures = settled.filter((entry) => !entry.ok).map((entry) => ({ siteId: entry.siteId, label: entry.label, error: (entry as { error: string }).error }));

  if (succeeded.length > 0) {
    const perSite: SiteIngestResult[] = succeeded.map((entry) => entry.stats);
    await ingestHousehold(identity.userId, perSite, succeeded[0].timezone, now).catch(() => { /* best-effort */ });
  }

  return {
    ingestedAt: now.toISOString(),
    sites: succeeded.map((entry) => ({ siteId: entry.siteId, label: entry.label, capacityFilled: entry.capacityFilled, alarmsStored: entry.alarmsStored })),
    failures,
  };
}

/**
 * Ingests every owner that has stored provider credentials — the shape a cron
 * needs, since a schedule has no signed-in viewer to scope to.
 */
export async function ingestAllUsers() {
  const db = getDb();
  const rows = await db.selectDistinct({ userId: providerAccounts.userId }).from(providerAccounts);
  const results = [];
  for (const row of rows) {
    try {
      results.push({ userId: row.userId, ...(await ingestForUser({ userId: row.userId, email: `${row.userId}@gridline.invalid`, displayName: null })) });
    } catch (error) {
      results.push({ userId: row.userId, error: error instanceof Error ? error.message : "Ingestion failed" });
    }
  }
  return results;
}
