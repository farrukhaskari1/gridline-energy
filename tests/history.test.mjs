import assert from "node:assert/strict";
import test from "node:test";
import { RANGES, mergeBucket, summarize, buildInsights } from "../lib/history.ts";

function bucketRow(siteId, overrides = {}) {
  return {
    bucket: 1_787_486_400, site_id: siteId, samples: 4, first_at: 1_787_486_400, last_at: 1_787_487_200,
    pv_w: 0, load_w: 0, grid_w: 0, battery_w: 0, battery_soc: null, generator_w: 0, online_percent: 100,
    peak_load_w: 0, peak_solar_w: 0, min_battery_soc: null, max_battery_soc: null, ...overrides,
  };
}

test("two inverters generating 2 kW each combine to 4 kW, not 2 kW", () => {
  // This is the regression the old route had: it grouped both sites into one
  // bucket and took AVG(), so a household total read as the mean.
  const merged = mergeBucket([
    bucketRow("a", { pv_w: 2_000, load_w: 1_500 }),
    bucketRow("b", { pv_w: 2_000, load_w: 900 }),
  ], new Map());

  assert.equal(merged.pv_w, 4_000);
  assert.equal(merged.load_w, 2_400);
  assert.equal(merged.samples, 8);
});

test("state of charge is weighted by battery capacity", () => {
  const merged = mergeBucket([
    bucketRow("small", { battery_soc: 20 }),
    bucketRow("big", { battery_soc: 80 }),
  ], new Map([["small", 2], ["big", 6]]));

  // (20*2 + 80*6) / 8 = 65, not the naive 50.
  assert.equal(merged.battery_soc, 65);
});

test("availability is averaged while power is summed", () => {
  const merged = mergeBucket([
    bucketRow("a", { online_percent: 100, grid_w: 400 }),
    bucketRow("b", { online_percent: 0, grid_w: -100 }),
  ], new Map());

  assert.equal(merged.online_percent, 50);
  assert.equal(merged.grid_w, 300, "opposing grid flows net out, as they do at the meter");
});

test("a site with no state of charge does not drag the combined figure down", () => {
  const merged = mergeBucket([
    bucketRow("battery", { battery_soc: 60 }),
    bucketRow("no-battery", { battery_soc: null }),
  ], new Map([["battery", 4]]));

  assert.equal(merged.battery_soc, 60);
});

test("battery extremes span every site rather than one", () => {
  const merged = mergeBucket([
    bucketRow("a", { min_battery_soc: 42, max_battery_soc: 88 }),
    bucketRow("b", { min_battery_soc: 19, max_battery_soc: 71 }),
  ], new Map());

  assert.equal(merged.min_battery_soc, 19);
  assert.equal(merged.max_battery_soc, 88);
});

test("summarize converts averaged watts into energy over the represented window", () => {
  const rows = [
    bucketRow("a", { bucket: 0, first_at: 0, last_at: 890, pv_w: 1_000, load_w: 2_000, grid_w: 1_000 }),
    bucketRow("a", { bucket: 900, first_at: 900, last_at: 1_790, pv_w: 3_000, load_w: 2_000, grid_w: -1_000 }),
  ];
  const result = summarize(rows, RANGES.day, 86_400);

  // 1 kW then 3 kW, each held for 900 s => 0.25 + 0.75 kWh.
  assert.ok(Math.abs(result.summary.solarKWh - 1) < 0.01);
  assert.ok(Math.abs(result.summary.consumptionKWh - 1) < 0.01);
  assert.ok(Math.abs(result.summary.gridImportKWh - 0.25) < 0.01);
  assert.ok(Math.abs(result.summary.gridExportKWh - 0.25) < 0.01);
  assert.equal(result.points.length, 2);
});

test("a combined total says so when one inverter recorded nothing", () => {
  const result = summarize([bucketRow("a", { load_w: 1_000 })], RANGES.day, 86_400);
  const insights = buildInsights(result, { hasRows: true, partialSiteLabels: ["Shop"] });

  assert.ok(insights.some((line) => line.includes("incomplete") && line.includes("Shop")));
});

test("an empty period explains itself instead of reporting zeroes as fact", () => {
  const result = summarize([], RANGES.day, 86_400);
  const insights = buildInsights(result, { hasRows: false });

  assert.equal(result.points.length, 0);
  assert.equal(result.summary.solarKWh, 0);
  assert.ok(insights[0].includes("No stored readings"));
});
