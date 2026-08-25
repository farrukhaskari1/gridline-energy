/**
 * Pure energy + savings math. No database or Worker imports, so it is unit
 * testable directly and shared by the roll-up engine.
 */
import type { ItelEnergyStat, StatDimension } from "./itel";

export type Tariff = {
  currency: string;
  importPerKwh: number | null;
  exportPerKwh: number;
  gridExportOffset: number;
};

export type PeriodKeys = { day: string; month: string; year: string };

export type SavingsFigures = {
  selfConsumedKwh: number;
  estimatedSavings: number;
  estimatedGridCost: number;
  baselineCost: number;
};

export const EMPTY_STAT: ItelEnergyStat = {
  generationKwh: null, consumptionKwh: null, gridImportKwh: null, gridExportKwh: null,
  batteryChargeKwh: null, batteryDischargeKwh: null, selfConsumedKwh: null,
};

export function num(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function hasAnyFigure(stat: ItelEnergyStat): boolean {
  return Object.values(stat).some((value) => value !== null);
}

/** Day/month/year keys in the site's own timezone, so month/year are a prefix of day. */
export function periodKeysFor(timezone: string, now: Date): PeriodKeys {
  let parts: Record<string, string> = {};
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
    for (const part of fmt.formatToParts(now)) if (part.type !== "literal") parts[part.type] = part.value;
  } catch {
    const iso = now.toISOString();
    parts = { year: iso.slice(0, 4), month: iso.slice(5, 7), day: iso.slice(8, 10) };
  }
  return { day: `${parts.year}-${parts.month}-${parts.day}`, month: `${parts.year}-${parts.month}`, year: parts.year };
}

export function keyForDimension(keys: PeriodKeys, dimension: StatDimension): string {
  return dimension === "year" ? keys.year : dimension === "month" ? keys.month : keys.day;
}

/**
 * Values a period's energy in money under a tariff. Mirrors `EnergyAnalytics`:
 * self-consumed solar is valued at the import rate it avoided, exports at the
 * configured export credit (or import ÷ offset when no explicit credit is set).
 */
export function computeSavings(stat: ItelEnergyStat, tariff: Tariff): SavingsFigures {
  const generation = num(stat.generationKwh);
  const gridExport = num(stat.gridExportKwh);
  const gridImport = num(stat.gridImportKwh);
  const consumption = num(stat.consumptionKwh);
  const selfConsumed = stat.selfConsumedKwh ?? Math.max(0, generation - gridExport);
  const rate = tariff.importPerKwh;
  if (rate === null) return { selfConsumedKwh: selfConsumed, estimatedSavings: 0, estimatedGridCost: 0, baselineCost: 0 };
  const effectiveExportRate = tariff.exportPerKwh > 0 ? tariff.exportPerKwh : (tariff.gridExportOffset ? rate / tariff.gridExportOffset : 0);
  return {
    selfConsumedKwh: selfConsumed,
    estimatedSavings: selfConsumed * rate + gridExport * effectiveExportRate,
    estimatedGridCost: Math.max(0, gridImport * rate - gridExport * effectiveExportRate),
    baselineCost: consumption * rate,
  };
}

/** Adds two energy stats field-by-field, treating null as absent (household aggregation). */
export function addStats(a: ItelEnergyStat, b: ItelEnergyStat): ItelEnergyStat {
  const combine = (x: number | null, y: number | null) => (x === null && y === null ? null : num(x) + num(y));
  return {
    generationKwh: combine(a.generationKwh, b.generationKwh),
    consumptionKwh: combine(a.consumptionKwh, b.consumptionKwh),
    gridImportKwh: combine(a.gridImportKwh, b.gridImportKwh),
    gridExportKwh: combine(a.gridExportKwh, b.gridExportKwh),
    batteryChargeKwh: combine(a.batteryChargeKwh, b.batteryChargeKwh),
    batteryDischargeKwh: combine(a.batteryDischargeKwh, b.batteryDischargeKwh),
    selfConsumedKwh: combine(a.selfConsumedKwh, b.selfConsumedKwh),
  };
}

/** Fills a consumption figure when the provider only reports the flow parts. */
export function deriveConsumption(stat: ItelEnergyStat): ItelEnergyStat {
  if (stat.consumptionKwh !== null) return stat;
  const parts = [stat.generationKwh, stat.gridImportKwh, stat.gridExportKwh, stat.batteryChargeKwh, stat.batteryDischargeKwh];
  if (parts.every((value) => value === null)) return stat;
  const derived = num(stat.generationKwh) + num(stat.gridImportKwh) + num(stat.batteryDischargeKwh) - num(stat.gridExportKwh) - num(stat.batteryChargeKwh);
  return { ...stat, consumptionKwh: Math.max(0, derived) };
}

export function mergeMissing(base: ItelEnergyStat, extra: Partial<ItelEnergyStat>): ItelEnergyStat {
  const merged = { ...base };
  for (const key of Object.keys(extra) as Array<keyof ItelEnergyStat>) {
    if (merged[key] === null && extra[key] !== undefined && extra[key] !== null) merged[key] = extra[key] as number;
  }
  return merged;
}
