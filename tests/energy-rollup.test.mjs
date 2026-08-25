import assert from "node:assert/strict";
import test from "node:test";
import { computeSavings, addStats, periodKeysFor, keyForDimension, deriveConsumption, EMPTY_STAT } from "../lib/energy-math.ts";
import { normalizeEnergyStat } from "../lib/itel.ts";

const TARIFF = { currency: "PKR", importPerKwh: 63, exportPerKwh: 0, gridExportOffset: 2 };

test("savings value self-consumed solar at the import rate and exports at import/offset", () => {
  const stat = { ...EMPTY_STAT, generationKwh: 10, consumptionKwh: 8, gridImportKwh: 2, gridExportKwh: 3, selfConsumedKwh: 7 };
  const s = computeSavings(stat, TARIFF);
  // self-consumed 7 * 63 + export 3 * (63/2=31.5) = 441 + 94.5
  assert.equal(s.estimatedSavings, 7 * 63 + 3 * 31.5);
  // grid cost max(0, import 2*63 - export 3*31.5) = max(0, 126 - 94.5)
  assert.equal(s.estimatedGridCost, Math.max(0, 2 * 63 - 3 * 31.5));
  assert.equal(s.baselineCost, 8 * 63);
});

test("no tariff yields zero money but preserves self-consumed energy", () => {
  const stat = { ...EMPTY_STAT, generationKwh: 5, gridExportKwh: 1 };
  const s = computeSavings(stat, { ...TARIFF, importPerKwh: null });
  assert.equal(s.estimatedSavings, 0);
  assert.equal(s.selfConsumedKwh, 4);
});

test("household stats sum per field and keep null when every site is null", () => {
  const a = { ...EMPTY_STAT, generationKwh: 4, consumptionKwh: 3 };
  const b = { ...EMPTY_STAT, generationKwh: 6, consumptionKwh: 2 };
  const sum = addStats(a, b);
  assert.equal(sum.generationKwh, 10);
  assert.equal(sum.consumptionKwh, 5);
  assert.equal(sum.gridImportKwh, null); // neither reported it
});

test("period keys nest month and year inside day in the site timezone", () => {
  const keys = periodKeysFor("Asia/Karachi", new Date("2026-08-20T04:00:00Z")); // 09:00 PKT
  assert.equal(keys.day, "2026-08-20");
  assert.equal(keys.month, "2026-08");
  assert.equal(keys.year, "2026");
  assert.equal(keyForDimension(keys, "month"), "2026-08");
});

test("consumption is derived from flow parts when the provider omits it", () => {
  const stat = deriveConsumption({ ...EMPTY_STAT, generationKwh: 10, gridImportKwh: 4, gridExportKwh: 3, batteryChargeKwh: 2, batteryDischargeKwh: 1 });
  // 10 + 4 + 1 - 3 - 2 = 10
  assert.equal(stat.consumptionKwh, 10);
});

test("normalizeEnergyStat resolves aliased provider field names", () => {
  const stat = normalizeEnergyStat({ pvGeneration: "12.5", loadRecharge: 9.2, gridBuy: 3, sellEnergy: 1.5 });
  assert.equal(stat.generationKwh, 12.5);
  assert.equal(stat.consumptionKwh, 9.2);
  assert.equal(stat.gridImportKwh, 3);
  assert.equal(stat.gridExportKwh, 1.5);
  // self-consumed derived: generation - export = 11
  assert.equal(stat.selfConsumedKwh, 11);
});

test("normalizeEnergyStat maps report-flow buckets", () => {
  const stat = normalizeEnergyStat({ fromSolarTotal: 20, fromGridTotal: 5, toGridTotal: 4, fromBatteryTotal: 2, toBatteryTotal: 3 });
  assert.equal(stat.generationKwh, 20);
  assert.equal(stat.gridImportKwh, 5);
  assert.equal(stat.gridExportKwh, 4);
  assert.equal(stat.batteryDischargeKwh, 2);
  assert.equal(stat.batteryChargeKwh, 3);
});
