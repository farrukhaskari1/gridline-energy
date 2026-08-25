import { NextResponse } from "next/server";
import { isLocalPreview } from "../../../request-origin";
import { getChatGPTUser } from "../../../chatgpt-auth";
import { getD1 } from "../../../../db";
import { listSites } from "../../../../lib/accounts";
import { RANGES, buildInsights, isRangeKey, mergeBucket, summarize, type BucketRow } from "../../../../lib/history";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const rangeKey = url.searchParams.get("range") || "day";
  if (!isRangeKey(rangeKey)) return NextResponse.json({ error: "Unsupported range" }, { status: 400 });
  const range = RANGES[rangeKey];

  const viewer = await getChatGPTUser();
  const isLocal = isLocalPreview(url.hostname);
  if (!viewer && !isLocal) return NextResponse.json({ error: "Authentication required" }, { status: 401 });

  // `siteId` absent or "all" means the household total. A named site means that
  // inverter alone.
  const requestedSite = url.searchParams.get("siteId");
  const wantsCombined = requestedSite === null || requestedSite === "" || requestedSite === "all";

  try {
    const userId = viewer?.userId ?? "local-preview";
    const now = Math.floor(Date.now() / 1000);
    const since = range.seconds === null ? 0 : now - range.seconds;

    const known = await listSites(userId, { includeHidden: true }).catch(() => []);
    if (!wantsCombined && !known.some((site) => site.siteId === requestedSite)) {
      return NextResponse.json({ error: "That site does not belong to this account" }, { status: 404 });
    }
    const visible = known.filter((site) => !site.hidden);
    const scoped = wantsCombined ? visible : known.filter((site) => site.siteId === requestedSite);
    const capacities = new Map(known.map((site) => [site.siteId, site.batteryCapacityKWh]));
    const labels = new Map(known.map((site) => [site.siteId, site.displayName]));

    const filters = ["s.user_id = ?", "t.recorded_at >= ?"];
    const bindings: Array<string | number> = [range.bucketSeconds, range.bucketSeconds, userId, since];
    if (!wantsCombined) { filters.push("t.site_id = ?"); bindings.push(requestedSite); }
    else if (visible.length > 0) {
      // Hidden inverters stay out of the household total; the operator hid them
      // for a reason and a total that silently includes them is a lie.
      filters.push(`t.site_id IN (${visible.map(() => "?").join(", ")})`);
      bindings.push(...visible.map((site) => site.siteId));
    } else filters.push("1 = 0");

    const result = await getD1().prepare(`
      SELECT
        CAST(t.recorded_at / ? AS INTEGER) * ? AS bucket,
        t.site_id AS site_id,
        COUNT(*) AS samples,
        MIN(t.recorded_at) AS first_at,
        MAX(t.recorded_at) AS last_at,
        AVG(t.pv_power_w) AS pv_w,
        AVG(t.load_power_w) AS load_w,
        AVG(t.grid_power_w) AS grid_w,
        AVG(t.battery_power_w) AS battery_w,
        AVG(t.battery_soc_percent) AS battery_soc,
        AVG(t.generator_power_w) AS generator_w,
        AVG(CASE WHEN t.online = 1 THEN 100.0 ELSE 0.0 END) AS online_percent,
        MAX(t.load_power_w) AS peak_load_w,
        MAX(t.pv_power_w) AS peak_solar_w,
        MIN(t.battery_soc_percent) AS min_battery_soc,
        MAX(t.battery_soc_percent) AS max_battery_soc
      FROM telemetry t
      INNER JOIN sites s ON s.id = t.site_id
      WHERE ${filters.join(" AND ")}
      GROUP BY bucket, t.site_id
      ORDER BY bucket ASC
    `).bind(...bindings).all<BucketRow>();

    const rows: BucketRow[] = result.results ?? [];

    // Per-site series first, so a household total and its parts are always
    // derived from exactly the same rows.
    const bySite = new Map<string, BucketRow[]>();
    for (const row of rows) {
      const bucket = bySite.get(row.site_id);
      if (bucket) bucket.push(row); else bySite.set(row.site_id, [row]);
    }
    const perSite = scoped.map((site) => {
      const siteRows = bySite.get(site.siteId) ?? [];
      const computed = summarize(siteRows, range, now);
      return {
        siteId: site.siteId, displayName: site.displayName, accountLabel: site.accountLabel,
        batteryCapacityKWh: site.batteryCapacityKWh, hidden: site.hidden,
        points: computed.points, summary: computed.summary, coverage: computed.coverage,
      };
    });

    const byBucket = new Map<number, BucketRow[]>();
    for (const row of rows) {
      const bucket = byBucket.get(row.bucket);
      if (bucket) bucket.push(row); else byBucket.set(row.bucket, [row]);
    }
    const headlineRows = wantsCombined
      ? [...byBucket.entries()].sort((a, b) => a[0] - b[0]).map(([, group]) => (group.length === 1 ? group[0] : mergeBucket(group, capacities)))
      : rows;

    const headline = summarize(headlineRows, range, now);
    const contributing = new Set(rows.map((row) => row.site_id));
    const partialSiteLabels = wantsCombined && scoped.length > 1
      ? scoped.filter((site) => !contributing.has(site.siteId)).map((site) => labels.get(site.siteId) ?? site.siteId)
      : [];

    return NextResponse.json({
      range: rangeKey, label: range.label, bucketSeconds: range.bucketSeconds,
      from: new Date(since * 1000).toISOString(), to: new Date(now * 1000).toISOString(),
      siteId: wantsCombined ? "all" : requestedSite,
      siteCount: scoped.length,
      incomplete: partialSiteLabels.length > 0,
      coverage: headline.coverage, points: headline.points, summary: headline.summary,
      insights: buildInsights(headline, { hasRows: headlineRows.length > 0, partialSiteLabels }),
      sites: perSite,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Energy history is unavailable";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
