/**
 * When solar counts as generating.
 *
 * These thresholds exist in three places — the web overview, the Swift
 * `SolarState`, and the widgets — and they have to agree, or the same inverter
 * reads "generating" on the phone and "idle" in the browser at the same
 * instant. They live here so there is one number to change.
 *
 * The floor is 1 W rather than 0 because inverters report a few hundred
 * milliwatts of sensor noise overnight, and a panel that is genuinely producing
 * 3 W at first light is *not* idle — it is low. Anything that treats "small" as
 * "off" hides the two most interesting moments of the day.
 */

export type SolarState = "generating" | "low" | "idle";

export const SOLAR_GENERATING_W = 20;
export const SOLAR_LOW_W = 1;

export function solarState(watts: number | null | undefined): SolarState {
  if (typeof watts !== "number" || !Number.isFinite(watts)) return "idle";
  const magnitude = Math.abs(watts);
  if (magnitude >= SOLAR_GENERATING_W) return "generating";
  if (magnitude >= SOLAR_LOW_W) return "low";
  return "idle";
}

export function solarStateLabel(state: SolarState) {
  switch (state) {
    case "generating": return "Generating";
    case "low": return "Low light";
    case "idle": return "Idle";
  }
}
