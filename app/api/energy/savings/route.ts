import { NextResponse } from "next/server";
import { isLocalPreview } from "../../../request-origin";
import { getChatGPTUser } from "../../../chatgpt-auth";
import { getD1 } from "../../../../db";
import { listSites } from "../../../../lib/accounts";

export const dynamic = "force-dynamic";

type SavingsRow = {
  period_type: string; period_key: string; currency: string;
  generated_kwh: number; consumed_kwh: number; grid_import_kwh: number; grid_export_kwh: number; self_consumed_kwh: number;
  estimated_savings: number; estimated_grid_cost: number; baseline_cost: number; source: string; updated_at: number;
};

function shape(row: SavingsRow | undefined | null) {
  if (!row) return null;
  return {
    periodKey: row.period_key, currency: row.currency,
    generatedKwh: row.generated_kwh, consumedKwh: row.consumed_kwh,
    gridImportKwh: row.grid_import_kwh, gridExportKwh: row.grid_export_kwh, selfConsumedKwh: row.self_consumed_kwh,
    estimatedSavings: row.estimated_savings, estimatedGridCost: row.estimated_grid_cost, baselineCost: row.baseline_cost,
    source: row.source, updatedAt: new Date(row.updated_at * 1000).toISOString(),
  };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const viewer = await getChatGPTUser();
  const isLocal = isLocalPreview(url.hostname);
  if (!viewer && !isLocal) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  const userId = viewer?.userId ?? "local-preview";

  const requestedSite = url.searchParams.get("siteId");
  const wantsHousehold = requestedSite === null || requestedSite === "" || requestedSite === "all";

  try {
    if (!wantsHousehold) {
      const known = await listSites(userId, { includeHidden: true }).catch(() => []);
      if (!known.some((site) => site.siteId === requestedSite)) {
        return NextResponse.json({ error: "That site does not belong to this account" }, { status: 404 });
      }
    }
    const db = getD1();
    const scopeSql = wantsHousehold ? "site_id IS NULL" : "site_id = ?";
    const scopeBind = wantsHousehold ? [] : [requestedSite as string];

    async function series(periodType: string, limit: number): Promise<SavingsRow[]> {
      const rows = await db.prepare(
        `SELECT period_type, period_key, currency, generated_kwh, consumed_kwh, grid_import_kwh, grid_export_kwh, self_consumed_kwh, estimated_savings, estimated_grid_cost, baseline_cost, source, updated_at
         FROM savings_rollup WHERE user_id = ? AND ${scopeSql} AND period_type = ? ORDER BY period_key DESC LIMIT ?`
      ).bind(userId, ...scopeBind, periodType, limit).all<SavingsRow>();
      return (rows.results ?? []).reverse();
    }

    const [days, months, years] = await Promise.all([series("day", 31), series("month", 12), series("year", 5)]);
    const latest = (rows: SavingsRow[]) => shape(rows.at(-1));

    return NextResponse.json({
      siteId: wantsHousehold ? "all" : requestedSite,
      currency: (years.at(-1) ?? months.at(-1) ?? days.at(-1))?.currency ?? "PKR",
      today: latest(days), month: latest(months), year: latest(years),
      series: {
        days: days.map(shape), months: months.map(shape), years: years.map(shape),
      },
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Savings are unavailable" }, { status: 502 });
  }
}
