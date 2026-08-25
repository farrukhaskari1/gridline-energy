/**
 * Bucketed telemetry aggregation.
 *
 * This used to live inline in `/api/energy/history`, where it did something
 * quietly wrong once a second inverter existed: it grouped every site's rows
 * into one bucket and took `AVG()`. Two inverters generating 2 kW each reported
 * 2 kW, not 4 kW — a household total that silently reads as the *mean* of its
 * inverters. Aggregation now happens per (bucket, site) in SQL, and combining
 * across sites happens here, where "sum the power, weight the state of charge"
 * can be stated explicitly and tested.
 */

export const RANGES = {
  day: { seconds: 86_400, bucketSeconds: 900, label: "Last 24 hours" },
  twoDays: { seconds: 172_800, bucketSeconds: 1_800, label: "Last 2 days" },
  week: { seconds: 604_800, bucketSeconds: 7_200, label: "Last 7 days" },
  month: { seconds: 2_592_000, bucketSeconds: 28_800, label: "Last 30 days" },
  year: { seconds: 31_536_000, bucketSeconds: 86_400, label: "Last 12 months" },
  lifetime: { seconds: null, bucketSeconds: 86_400, label: "All recorded history" },
} as const;

export type RangeKey = keyof typeof RANGES;
export type Range = (typeof RANGES)[RangeKey];

export function isRangeKey(value: string): value is RangeKey {
  return Object.prototype.hasOwnProperty.call(RANGES, value);
}

/** One (bucket, site) group exactly as SQL returns it. */
export type BucketRow = {
  bucket: number; site_id: string; samples: number; first_at: number; last_at: number;
  pv_w: number | null; load_w: number | null; grid_w: number | null;
  battery_w: number | null; battery_soc: number | null; generator_w: number | null; online_percent: number | null;
  peak_load_w: number | null; peak_solar_w: number | null; min_battery_soc: number | null; max_battery_soc: number | null;
};

function n(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Folds every site's rows for one bucket into a single row.
 *
 * Power and sample counts add up. State of charge is weighted by usable battery
 * capacity, because averaging a 2 kWh bank at 20% with a 6 kWh bank at 80%
 * gives 50% when the household actually holds 65% of its stored energy — the
 * same rule `lib/combine.ts` applies to live readings, kept deliberately
 * identical so live and historical figures cannot disagree.
 */
export function mergeBucket(rows: BucketRow[], capacities: Map<string, number | null>): BucketRow {
  const weightFor = (row: BucketRow) => {
    const capacity = capacities.get(row.site_id);
    return typeof capacity === "number" && capacity > 0 ? capacity : 1;
  };
  const socRows = rows.filter((row) => row.battery_soc !== null);
  const socWeight = socRows.reduce((sum, row) => sum + weightFor(row), 0);

  const minima = rows.map((row) => row.min_battery_soc).filter((value): value is number => value !== null);
  const maxima = rows.map((row) => row.max_battery_soc).filter((value): value is number => value !== null);

  return {
    bucket: rows[0].bucket,
    site_id: "__combined__",
    samples: rows.reduce((sum, row) => sum + row.samples, 0),
    first_at: Math.min(...rows.map((row) => row.first_at)),
    last_at: Math.max(...rows.map((row) => row.last_at)),
    pv_w: rows.reduce((sum, row) => sum + n(row.pv_w), 0),
    load_w: rows.reduce((sum, row) => sum + n(row.load_w), 0),
    grid_w: rows.reduce((sum, row) => sum + n(row.grid_w), 0),
    battery_w: rows.reduce((sum, row) => sum + n(row.battery_w), 0),
    battery_soc: socWeight > 0 ? socRows.reduce((sum, row) => sum + n(row.battery_soc) * weightFor(row), 0) / socWeight : null,
    generator_w: rows.reduce((sum, row) => sum + n(row.generator_w), 0),
    // Availability is a property of the household, so it is the mean of the
    // inverters rather than their sum — two inverters both at 100% is 100%.
    online_percent: rows.length ? rows.reduce((sum, row) => sum + n(row.online_percent), 0) / rows.length : null,
    // Peaks within a bucket are summed rather than maxed: the household's draw
    // at any instant is the sum of its inverters', and at bucket granularity
    // the sum of per-site peaks is the closest available upper bound.
    peak_load_w: rows.reduce((sum, row) => sum + n(row.peak_load_w), 0),
    peak_solar_w: rows.reduce((sum, row) => sum + n(row.peak_solar_w), 0),
    min_battery_soc: minima.length ? Math.min(...minima) : null,
    max_battery_soc: maxima.length ? Math.max(...maxima) : null,
  };
}

export type SeriesPoint = {
  time: string; samples: number; representedSeconds: number;
  solarW: number; loadW: number; gridW: number; batteryW: number;
  batterySoc: number; generatorW: number; onlinePercent: number;
};

export function summarize(rows: BucketRow[], range: Range, nowSeconds: number) {
  let solarWh = 0, loadWh = 0, gridImportWh = 0, gridExportWh = 0, generatorWh = 0, observedSeconds = 0;
  let peakLoadW = 0, peakLoadAt: number | null = null, peakSolarW = 0, peakSolarAt: number | null = null;
  let batteryMinPercent = Infinity, batteryMaxPercent = -Infinity, weightedSoc = 0, onlineWeighted = 0, totalSamples = 0;

  const points: SeriesPoint[] = rows.map((row) => {
    const representedSeconds = Math.min(range.bucketSeconds, Math.max(10, row.last_at - row.first_at + 10));
    observedSeconds += representedSeconds;
    solarWh += Math.max(0, n(row.pv_w)) * representedSeconds / 3600;
    loadWh += Math.max(0, n(row.load_w)) * representedSeconds / 3600;
    gridImportWh += Math.max(0, n(row.grid_w)) * representedSeconds / 3600;
    gridExportWh += Math.max(0, -n(row.grid_w)) * representedSeconds / 3600;
    generatorWh += Math.max(0, n(row.generator_w)) * representedSeconds / 3600;
    if (n(row.peak_load_w) > peakLoadW) { peakLoadW = n(row.peak_load_w); peakLoadAt = row.bucket; }
    if (n(row.peak_solar_w) > peakSolarW) { peakSolarW = n(row.peak_solar_w); peakSolarAt = row.bucket; }
    if (row.min_battery_soc !== null) batteryMinPercent = Math.min(batteryMinPercent, row.min_battery_soc);
    if (row.max_battery_soc !== null) batteryMaxPercent = Math.max(batteryMaxPercent, row.max_battery_soc);
    weightedSoc += n(row.battery_soc) * representedSeconds;
    onlineWeighted += n(row.online_percent) * row.samples; totalSamples += row.samples;
    return {
      time: new Date(row.bucket * 1000).toISOString(), samples: row.samples, representedSeconds,
      solarW: Math.round(n(row.pv_w)), loadW: Math.round(n(row.load_w)), gridW: Math.round(n(row.grid_w)),
      batteryW: Math.round(n(row.battery_w)), batterySoc: Math.round(n(row.battery_soc) * 10) / 10,
      generatorW: Math.round(n(row.generator_w)), onlinePercent: Math.round(n(row.online_percent) * 10) / 10,
    };
  });

  const periodSeconds = range.seconds ?? (rows[0] ? Math.max(1, nowSeconds - rows[0].first_at) : 1);
  const coveragePercent = Math.min(100, observedSeconds / periodSeconds * 100);
  const selfSufficiency = loadWh > 0 ? Math.max(0, Math.min(100, (1 - gridImportWh / loadWh) * 100)) : 0;
  const firstSoc = points[0]?.batterySoc ?? null;
  const lastSoc = points.at(-1)?.batterySoc ?? null;

  const summary = {
    solarKWh: solarWh / 1000, consumptionKWh: loadWh / 1000, gridImportKWh: gridImportWh / 1000,
    gridExportKWh: gridExportWh / 1000, generatorKWh: generatorWh / 1000, selfSufficiencyPercent: selfSufficiency,
    gridDependencePercent: loadWh > 0 ? Math.min(100, gridImportWh / loadWh * 100) : 0,
    solarToDemandPercent: loadWh > 0 ? Math.min(999, solarWh / loadWh * 100) : 0,
    solarSelfConsumedKWh: Math.max(0, (solarWh - gridExportWh) / 1000),
    loadFactorPercent: peakLoadW > 0 && observedSeconds ? Math.min(100, (loadWh * 3600 / observedSeconds) / peakLoadW * 100) : 0,
    peakLoadW, peakAt: peakLoadAt ? new Date(peakLoadAt * 1000).toISOString() : null,
    peakSolarW, peakSolarAt: peakSolarAt ? new Date(peakSolarAt * 1000).toISOString() : null,
    averageLoadW: observedSeconds ? loadWh * 3600 / observedSeconds : 0,
    batteryStartPercent: firstSoc, batteryEndPercent: lastSoc,
    batteryMinPercent: Number.isFinite(batteryMinPercent) ? batteryMinPercent : null,
    batteryMaxPercent: Number.isFinite(batteryMaxPercent) ? batteryMaxPercent : null,
    batteryAveragePercent: observedSeconds ? weightedSoc / observedSeconds : null,
    availabilityPercent: totalSamples ? onlineWeighted / totalSamples : 0,
  };

  const coverage = {
    percent: coveragePercent, observedSeconds,
    samples: rows.reduce((sum, row) => sum + row.samples, 0),
    firstAt: rows[0] ? new Date(rows[0].first_at * 1000).toISOString() : null,
    lastAt: rows.at(-1) ? new Date(rows.at(-1)!.last_at * 1000).toISOString() : null,
  };

  return { points, summary, coverage, coveragePercent, selfSufficiency, peakLoadW, peakLoadAt, firstSoc, lastSoc };
}

export function buildInsights(
  result: ReturnType<typeof summarize>,
  options: { hasRows: boolean; siteLabel?: string | null; partialSiteLabels?: string[] },
) {
  const insights: string[] = [];
  if (!options.hasRows) insights.push("No stored readings exist in this period yet. Open Overview to start collecting live data.");
  else if (result.coveragePercent < 20) insights.push(`Only ${result.coveragePercent.toFixed(1)}% of this period has recorded readings, so energy totals are partial—not full-period estimates.`);
  if (result.summary.consumptionKWh > 0) insights.push(`${result.selfSufficiency.toFixed(0)}% of observed demand was supplied without importing from the grid.`);
  if (result.peakLoadAt) {
    const peak = result.peakLoadW >= 1000 ? `${result.peakLoadW / 1000} kW` : `${result.peakLoadW} W`;
    insights.push(`Peak observed demand was ${peak} at ${new Date(result.peakLoadAt * 1000).toLocaleTimeString("en-PK", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Karachi" })}.`);
  }
  if (result.firstSoc !== null && result.lastSoc !== null) {
    insights.push(`Battery state of charge moved ${result.lastSoc - result.firstSoc >= 0 ? "up" : "down"} ${Math.abs(result.lastSoc - result.firstSoc).toFixed(0)} percentage points during recorded coverage.`);
  }
  // A combined total built from inverters with different coverage is not wrong,
  // but it is not comparable either. Saying so beats a footnote nobody reads.
  if (options.partialSiteLabels && options.partialSiteLabels.length > 0) {
    insights.push(`Combined totals are incomplete: ${options.partialSiteLabels.join(", ")} recorded nothing in this period.`);
  }
  return insights;
}
