import { NextResponse } from "next/server";
import { isLocalPreview } from "../../request-origin";
import { getChatGPTUser } from "../../chatgpt-auth";
import { getD1 } from "../../../db";
import { listSites } from "../../../lib/accounts";

export const dynamic = "force-dynamic";

type AlertRow = { id: string; site_id: string; severity: string; title: string; message: string | null; occurred_at: number; acknowledged_at: number | null };

export async function GET(request: Request) {
  const url = new URL(request.url);
  const viewer = await getChatGPTUser();
  const isLocal = isLocalPreview(url.hostname);
  if (!viewer && !isLocal) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  const userId = viewer?.userId ?? "local-preview";
  const requestedSite = url.searchParams.get("siteId");
  const wantsAll = requestedSite === null || requestedSite === "" || requestedSite === "all";

  try {
    const known = await listSites(userId, { includeHidden: true }).catch(() => []);
    const labels = new Map(known.map((site) => [site.siteId, site.displayName]));
    if (!wantsAll && !known.some((site) => site.siteId === requestedSite)) {
      return NextResponse.json({ error: "That site does not belong to this account" }, { status: 404 });
    }
    const scoped = wantsAll ? known.filter((site) => !site.hidden).map((site) => site.siteId) : [requestedSite as string];
    if (scoped.length === 0) return NextResponse.json({ alerts: [] }, { headers: { "Cache-Control": "no-store" } });

    const placeholders = scoped.map(() => "?").join(", ");
    const rows = await getD1().prepare(
      `SELECT id, site_id, severity, title, message, occurred_at, acknowledged_at FROM alerts WHERE site_id IN (${placeholders}) ORDER BY occurred_at DESC LIMIT 100`
    ).bind(...scoped).all<AlertRow>();

    return NextResponse.json({
      siteId: wantsAll ? "all" : requestedSite,
      alerts: (rows.results ?? []).map((row) => ({
        id: row.id, siteId: row.site_id, siteLabel: labels.get(row.site_id) ?? row.site_id,
        severity: row.severity, title: row.title, message: row.message,
        occurredAt: new Date(row.occurred_at * 1000).toISOString(),
        acknowledged: row.acknowledged_at !== null,
      })),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Alerts are unavailable" }, { status: 502 });
  }
}
