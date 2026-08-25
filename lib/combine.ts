/**
 * Combining several inverters into one reading.
 *
 * The rules live here — once — so the routes, the overview and the analytics
 * page cannot each invent their own version:
 *
 * - power and daily energy **sum**
 * - state of charge is weighted by battery capacity, not averaged
 * - load percentage and temperature take the **worst** site
 * - grid reads `outage` only when **every** site is out
 * - a total is marked incomplete when any site's reading is stale, so a partial
 *   figure is never presented as a whole one
 *
 * Kept identical to `SnapshotCombiner` on the Swift side.
 */

export type SiteTelemetry = {
  pvPowerW: number | null;
  loadPowerW: number | null;
  gridPowerW: number | null;
  batteryPowerW: number | null;
  batterySocPercent: number | null;
  generatorPowerW: number | null;
  loadPercent: number | null;
  inputVoltage: number | null;
  temperatureC: number | null;
  generatedTodayKWh: number | null;
  consumedTodayKWh: number | null;
  online: boolean;
};

export type SiteReading = {
  siteId: string;
  label: string;
  batteryCapacityKWh: number;
  /** Epoch milliseconds. */
  recordedAt: number;
  telemetry: SiteTelemetry;
};

export type CombinedReading = {
  telemetry: SiteTelemetry;
  siteCount: number;
  incomplete: boolean;
  staleSiteIds: string[];
};

export type GridAvailability = "available" | "outage" | "unknown";

export const STALE_AFTER_MS = 300_000;

function numeric(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Mirrors `EnergySnapshot.gridAvailability` exactly. */
export function gridAvailability(telemetry: SiteTelemetry): GridAvailability {
  const voltage = numeric(telemetry.inputVoltage);
  if (voltage !== null) {
    if (voltage < 80) return "outage";
    if (voltage >= 160) return "available";
  }
  const grid = numeric(telemetry.gridPowerW);
  if (grid !== null && Math.abs(grid) > 30) return "available";
  return "unknown";
}

function sum(values: Array<number | null>): number {
  return values.reduce<number>((total, value) => total + (numeric(value) ?? 0), 0);
}

/** Stays null when nothing is present, so a missing figure never becomes a confident zero. */
function sumIfAnyPresent(values: Array<number | null>): number | null {
  const present = values.map(numeric).filter((value): value is number => value !== null);
  return present.length === 0 ? null : present.reduce((total, value) => total + value, 0);
}

function worst(values: Array<number | null>, pick: "max" | "min"): number | null {
  const present = values.map(numeric).filter((value): value is number => value !== null);
  if (present.length === 0) return null;
  return pick === "max" ? Math.max(...present) : Math.min(...present);
}

export function combineReadings(
  readings: SiteReading[],
  options: { now?: number; staleAfterMs?: number } = {},
): CombinedReading | null {
  if (readings.length === 0) return null;

  const now = options.now ?? Date.now();
  const staleAfterMs = options.staleAfterMs ?? STALE_AFTER_MS;
  const stale = readings.filter((reading) => now - reading.recordedAt > staleAfterMs);

  const telemetries = readings.map((reading) => reading.telemetry);

  // The reported voltage decides the derived grid state, so taking the plain
  // minimum would let a single dead feed declare the whole house off.
  const everySiteOut = telemetries.every((telemetry) => gridAvailability(telemetry) === "outage");
  const voltageSource = everySiteOut ? telemetries : telemetries.filter((telemetry) => gridAvailability(telemetry) !== "outage");

  const weighted = readings
    .map((reading) => ({ soc: numeric(reading.telemetry.batterySocPercent), weight: Math.max(0.001, reading.batteryCapacityKWh) }))
    .filter((entry): entry is { soc: number; weight: number } => entry.soc !== null);
  const totalWeight = weighted.reduce((total, entry) => total + entry.weight, 0);
  const batterySocPercent = totalWeight > 0
    ? weighted.reduce((total, entry) => total + entry.soc * entry.weight, 0) / totalWeight
    : null;

  return {
    siteCount: readings.length,
    incomplete: stale.length > 0,
    staleSiteIds: stale.map((reading) => reading.siteId),
    telemetry: {
      pvPowerW: sum(telemetries.map((telemetry) => telemetry.pvPowerW)),
      loadPowerW: sum(telemetries.map((telemetry) => telemetry.loadPowerW)),
      gridPowerW: sum(telemetries.map((telemetry) => telemetry.gridPowerW)),
      batteryPowerW: sum(telemetries.map((telemetry) => telemetry.batteryPowerW)),
      generatorPowerW: sum(telemetries.map((telemetry) => telemetry.generatorPowerW)),
      batterySocPercent,
      loadPercent: worst(telemetries.map((telemetry) => telemetry.loadPercent), "max"),
      inputVoltage: worst(voltageSource.map((telemetry) => telemetry.inputVoltage), "min"),
      temperatureC: worst(telemetries.map((telemetry) => telemetry.temperatureC), "max"),
      generatedTodayKWh: sumIfAnyPresent(telemetries.map((telemetry) => telemetry.generatedTodayKWh)),
      consumedTodayKWh: sumIfAnyPresent(telemetries.map((telemetry) => telemetry.consumedTodayKWh)),
      online: telemetries.some((telemetry) => telemetry.online),
    },
  };
}
