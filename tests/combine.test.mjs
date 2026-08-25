import assert from "node:assert/strict";
import test from "node:test";
import { combineReadings, gridAvailability } from "../lib/combine.ts";

const BASE = 1_787_486_400_000;

function reading(overrides = {}, telemetry = {}, capacity = 2, recordedAt = BASE) {
  return {
    siteId: "site-a", label: "Gorsi Rd", batteryCapacityKWh: capacity, recordedAt,
    telemetry: {
      pvPowerW: 0, loadPowerW: 0, gridPowerW: 0, batteryPowerW: 0, batterySocPercent: null,
      generatorPowerW: 0, loadPercent: null, inputVoltage: 223, temperatureC: null,
      generatedTodayKWh: null, consumedTodayKWh: null, online: true, ...telemetry,
    },
    ...overrides,
  };
}

test("power sums and opposing grid flows cancel", () => {
  const combined = combineReadings([
    reading({ siteId: "a" }, { pvPowerW: 1200, loadPowerW: 1900, gridPowerW: 700 }),
    reading({ siteId: "b" }, { pvPowerW: 3100, loadPowerW: 2400, gridPowerW: -700 }),
  ], { now: BASE });

  assert.equal(combined.telemetry.pvPowerW, 4300);
  assert.equal(combined.telemetry.loadPowerW, 4300);
  assert.equal(combined.telemetry.gridPowerW, 0);
  assert.equal(combined.siteCount, 2);
});

test("state of charge is weighted by battery capacity, not averaged", () => {
  const combined = combineReadings([
    reading({ siteId: "a" }, { batterySocPercent: 100 }, 2),
    reading({ siteId: "b" }, { batterySocPercent: 20 }, 6),
  ], { now: BASE });

  // A mean would say 60%. Weighted by capacity it is 40%.
  assert.ok(Math.abs(combined.telemetry.batterySocPercent - 40) < 1e-9);
});

test("the worst load and temperature win so a critical inverter is never masked", () => {
  const combined = combineReadings([
    reading({ siteId: "a" }, { loadPercent: 20, temperatureC: 41, inputVoltage: 223 }),
    reading({ siteId: "b" }, { loadPercent: 94, temperatureC: 61, inputVoltage: 198 }),
  ], { now: BASE });

  assert.equal(combined.telemetry.loadPercent, 94);
  assert.equal(combined.telemetry.temperatureC, 61);
  assert.equal(combined.telemetry.inputVoltage, 198);
});

test("grid reads outage only when every site is out", () => {
  const oneOut = combineReadings([
    reading({ siteId: "a" }, { inputVoltage: 0, gridPowerW: 0 }),
    reading({ siteId: "b" }, { inputVoltage: 223, gridPowerW: 900 }),
  ], { now: BASE });
  assert.equal(gridAvailability(oneOut.telemetry), "available");

  const bothOut = combineReadings([
    reading({ siteId: "a" }, { inputVoltage: 0, gridPowerW: 0 }),
    reading({ siteId: "b" }, { inputVoltage: 0, gridPowerW: 0 }),
  ], { now: BASE });
  assert.equal(gridAvailability(bothOut.telemetry), "outage");
});

test("a stale site marks the total incomplete", () => {
  const combined = combineReadings([
    reading({ siteId: "a" }),
    reading({ siteId: "b" }, {}, 2, BASE - 3_600_000),
  ], { now: BASE });

  assert.equal(combined.incomplete, true);
  assert.deepEqual(combined.staleSiteIds, ["b"]);
});

test("a missing daily total stays missing instead of becoming zero", () => {
  const none = combineReadings([reading({ siteId: "a" }), reading({ siteId: "b" })], { now: BASE });
  assert.equal(none.telemetry.generatedTodayKWh, null);

  const partial = combineReadings([
    reading({ siteId: "a" }, { generatedTodayKWh: 11.6 }),
    reading({ siteId: "b" }),
  ], { now: BASE });
  assert.equal(partial.telemetry.generatedTodayKWh, 11.6);
});

test("combining nothing returns null rather than a zeroed reading", () => {
  assert.equal(combineReadings([], { now: BASE }), null);
});
