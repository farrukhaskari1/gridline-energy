/**
 * Energy roll-ups and money savings (persistence + provider orchestration).
 *
 * Reads the provider's own period counters — the same numbers the iTel app
 * shows — and persists them to `energy_daily` (authoritative per-day energy) and
 * `savings_rollup` (day / month / year money, per site and household), instead
 * of re-deriving kWh from polled power samples. Pure math lives in
 * `lib/energy-math.ts`; this module is the database and provider IO.
 */

import { getD1 } from "../db";
import {
  getDashboardStat, getEnergyStatistics, getGridStatistics, getReportFlow,
  type ItelDevice, type ItelEnergyStat, type StatDimension,
} from "./itel";
import {
  computeSavings, deriveConsumption, hasAnyFigure, keyForDimension, mergeMissing, num,
  periodKeysFor, EMPTY_STAT, addStats, type Tariff,
} from "./energy-math";

export { EMPTY_STAT, addStats, hasAnyFigure, periodKeysFor, keyForDimension } from "./energy-math";
export type { Tariff } from "./energy-math";

/** The effective tariff for a site: its own settings row if present, else the user-level default. */
export async function tariffForSite(userId: string, siteId: string | null): Promise<Tariff> {
  const db = getD1();
  type Row = { currency: string; import_tariff_per_kwh: number | null; export_credit_per_kwh: number | null; grid_export_offset: number };
  let row: Row | null = null;
  if (siteId) {
    row = await db.prepare("SELECT currency, import_tariff_per_kwh, export_credit_per_kwh, grid_export_offset FROM energy_settings WHERE user_id = ? AND site_id = ?").bind(userId, siteId).first<Row>();
  }
  if (!row) {
    row = await db.prepare("SELECT currency, import_tariff_per_kwh, export_credit_per_kwh, grid_export_offset FROM energy_settings WHERE user_id = ? AND site_id IS NULL").bind(userId).first<Row>();
  }
  return {
    currency: row?.currency ?? "PKR",
    importPerKwh: row?.import_tariff_per_kwh ?? null,
    exportPerKwh: row?.export_credit_per_kwh ?? 0,
    gridExportOffset: row?.grid_export_offset ?? 2,
  };
}

/** Upserts one authoritative day of energy for a site. */
export async function upsertEnergyDaily(siteId: string, day: string, stat: ItelEnergyStat, source: string, now: Date): Promise<void> {
  const db = getD1();
  await db.prepare(
    `INSERT INTO energy_daily (site_id, day, generated_kwh, consumed_kwh, grid_import_kwh, grid_export_kwh, battery_charge_kwh, battery_discharge_kwh, self_consumed_kwh, source, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(site_id, day) DO UPDATE SET
       generated_kwh = excluded.generated_kwh, consumed_kwh = excluded.consumed_kwh,
       grid_import_kwh = excluded.grid_import_kwh, grid_export_kwh = excluded.grid_export_kwh,
       battery_charge_kwh = excluded.battery_charge_kwh, battery_discharge_kwh = excluded.battery_discharge_kwh,
       self_consumed_kwh = excluded.self_consumed_kwh, source = excluded.source, updated_at = excluded.updated_at`
  ).bind(
    siteId, day, stat.generationKwh, stat.consumptionKwh, stat.gridImportKwh, stat.gridExportKwh,
    stat.batteryChargeKwh, stat.batteryDischargeKwh, stat.selfConsumedKwh, source, Math.floor(now.getTime() / 1000),
  ).run();
}

/** Upserts one period's savings row. `siteId` null is the household total. */
export async function upsertSavings(
  userId: string, siteId: string | null, periodType: StatDimension, periodKey: string,
  stat: ItelEnergyStat, tariff: Tariff, source: string, now: Date,
): Promise<void> {
  const db = getD1();
  const savings = computeSavings(stat, tariff);
  const conflict = siteId === null
    ? "ON CONFLICT(user_id, period_type, period_key) WHERE site_id IS NULL"
    : "ON CONFLICT(user_id, site_id, period_type, period_key) WHERE site_id IS NOT NULL";
  await db.prepare(
    `INSERT INTO savings_rollup (user_id, site_id, period_type, period_key, currency, generated_kwh, consumed_kwh, grid_import_kwh, grid_export_kwh, self_consumed_kwh, estimated_savings, estimated_grid_cost, baseline_cost, tariff_import_per_kwh, tariff_export_per_kwh, source, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ${conflict} DO UPDATE SET
       currency = excluded.currency, generated_kwh = excluded.generated_kwh, consumed_kwh = excluded.consumed_kwh,
       grid_import_kwh = excluded.grid_import_kwh, grid_export_kwh = excluded.grid_export_kwh, self_consumed_kwh = excluded.self_consumed_kwh,
       estimated_savings = excluded.estimated_savings, estimated_grid_cost = excluded.estimated_grid_cost, baseline_cost = excluded.baseline_cost,
       tariff_import_per_kwh = excluded.tariff_import_per_kwh, tariff_export_per_kwh = excluded.tariff_export_per_kwh, source = excluded.source, updated_at = excluded.updated_at`
  ).bind(
    userId, siteId, periodType, periodKey, tariff.currency,
    num(stat.generationKwh), num(stat.consumptionKwh), num(stat.gridImportKwh), num(stat.gridExportKwh), savings.selfConsumedKwh,
    savings.estimatedSavings, savings.estimatedGridCost, savings.baselineCost,
    tariff.importPerKwh, tariff.exportPerKwh, source, Math.floor(now.getTime() / 1000),
  ).run();
}

/**
 * One period's energy for a site.
 *
 * Primary source is `/v2/dashboard` (dimension 2/3/4 = day/month/year), which
 * returns the same period totals the iTel app shows on its cards — this is what
 * makes Gridline's figures match the provider app. The `/statistics` family is
 * a fallback for any figure the dashboard leaves out (older firmware).
 * Never throws: an unanswerable period comes back empty.
 */
export async function fetchSiteStat(
  accessToken: string,
  args: { stationId: number; deviceSn?: string; categoryCode?: string; dimension: StatDimension; dateKey: string; timeZone?: string },
): Promise<ItelEnergyStat> {
  let stat = EMPTY_STAT;
  try {
    stat = await getDashboardStat(accessToken, { stationId: args.stationId, deviceSn: args.deviceSn, categoryCode: args.categoryCode, dimension: args.dimension });
  } catch { /* fall back to the statistics family below */ }
  if (!hasAnyFigure(stat)) {
    try {
      stat = mergeMissing(stat, await getEnergyStatistics(accessToken, { stationId: args.stationId, deviceSn: args.deviceSn, dimension: args.dimension, date: args.dateKey, timeZone: args.timeZone }));
    } catch { /* backfill below */ }
  }
  if (stat.gridImportKwh === null || stat.gridExportKwh === null) {
    try {
      const grid = await getGridStatistics(accessToken, { stationId: args.stationId, deviceSn: args.deviceSn, dimension: args.dimension, date: args.dateKey, timeZone: args.timeZone });
      stat = mergeMissing(stat, grid);
    } catch { /* optional */ }
  }
  if (stat.generationKwh === null || stat.consumptionKwh === null) {
    try {
      const flow = await getReportFlow(accessToken, { stationId: args.stationId, deviceSn: args.deviceSn, dimension: args.dimension, reportTime: args.dateKey, timeZone: args.timeZone });
      stat = mergeMissing(stat, flow);
    } catch { /* optional */ }
  }
  return deriveConsumption(stat);
}

export type SiteIngestResult = { day: ItelEnergyStat; month: ItelEnergyStat; year: ItelEnergyStat };

/** Fetches and persists day/month/year energy and savings for one site. */
export async function ingestSite(
  accessToken: string,
  args: { userId: string; siteId: string; stationId: number; device: ItelDevice; timezone: string },
  now: Date,
): Promise<SiteIngestResult> {
  const keys = periodKeysFor(args.timezone, now);
  const tariff = await tariffForSite(args.userId, args.siteId);
  const dimensions = ["day", "month", "year"] as const;
  const stats = {} as SiteIngestResult;
  for (const dimension of dimensions) {
    const dateKey = keyForDimension(keys, dimension);
    const stat = await fetchSiteStat(accessToken, { stationId: args.stationId, deviceSn: args.device.deviceSn, categoryCode: args.device.categoryCode, dimension, dateKey, timeZone: args.timezone });
    stats[dimension] = stat;
    if (!hasAnyFigure(stat)) continue;
    if (dimension === "day") await upsertEnergyDaily(args.siteId, keys.day, stat, "provider", now);
    await upsertSavings(args.userId, args.siteId, dimension, dateKey, stat, tariff, "provider", now);
  }
  return stats;
}

/** Persists the household (all-sites) savings for each period from summed per-site stats. */
export async function ingestHousehold(userId: string, perSite: SiteIngestResult[], timezone: string, now: Date): Promise<void> {
  if (perSite.length === 0) return;
  const keys = periodKeysFor(timezone, now);
  const tariff = await tariffForSite(userId, null);
  const dimensions = ["day", "month", "year"] as const;
  for (const dimension of dimensions) {
    const summed = perSite.reduce<ItelEnergyStat>((total, site) => addStats(total, site[dimension]), EMPTY_STAT);
    if (hasAnyFigure(summed)) await upsertSavings(userId, null, dimension, keyForDimension(keys, dimension), summed, tariff, "provider", now);
  }
}
