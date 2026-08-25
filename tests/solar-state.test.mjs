import assert from "node:assert/strict";
import test from "node:test";
import { solarState, solarStateLabel, SOLAR_GENERATING_W, SOLAR_LOW_W } from "../lib/solar-state.ts";

test("a producing array is generating", () => {
  assert.equal(solarState(1_290), "generating");
  assert.equal(solarState(SOLAR_GENERATING_W), "generating");
});

test("first and last light read as low, not idle", () => {
  // The old web threshold was 5 W, so a panel making 3 W at dawn showed as off
  // and the flow animation never started.
  assert.equal(solarState(3), "low");
  assert.equal(solarState(SOLAR_LOW_W), "low");
  assert.equal(solarState(19.9), "low");
});

test("overnight sensor noise is idle", () => {
  assert.equal(solarState(0), "idle");
  assert.equal(solarState(0.4), "idle");
});

test("a missing reading is idle rather than a crash", () => {
  assert.equal(solarState(null), "idle");
  assert.equal(solarState(undefined), "idle");
  assert.equal(solarState(Number.NaN), "idle");
});

test("the kilowatt bug is what made a working array look idle", () => {
  // /home/flow reports kilowatts. Treating 1.29 kW as 1.29 W put it under every
  // threshold there has ever been — which is why nothing animated.
  assert.equal(solarState(1.29), "low");
  assert.equal(solarState(1.29 * 1_000), "generating");
});

test("states carry labels", () => {
  assert.equal(solarStateLabel("generating"), "Generating");
  assert.equal(solarStateLabel("low"), "Low light");
  assert.equal(solarStateLabel("idle"), "Idle");
});
