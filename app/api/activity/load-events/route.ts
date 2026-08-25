import { NextResponse } from "next/server";
import { isLocalPreview } from "../../../request-origin";
import { getChatGPTUser } from "../../../chatgpt-auth";
import { getD1 } from "../../../../db";
import { listSites } from "../../../../lib/accounts";

export const dynamic = "force-dynamic";

const rangeSeconds = { day: 86_400, week: 604_800, month: 2_592_000 } as const;
type RangeKey = keyof typeof rangeSeconds;
type EventType = "all" | "added" | "removed";
type EventRow = { id: number; action: string; detail_json: string | null; created_at: number; site_id: string | null; site_name: string | null };

export async function GET(request: Request) {
  const url = new URL(request.url);
  const range = (url.searchParams.get("range") || "day") as RangeKey;
  const type = (url.searchParams.get("type") || "all") as EventType;
  if (!rangeSeconds[range] || !["all", "added", "removed"].includes(type)) return NextResponse.json({ error: "Unsupported event filter" }, { status: 400 });
  const viewer = await getChatGPTUser();
  const isLocal = isLocalPreview(url.hostname);
  if (!viewer && !isLocal) return NextResponse.json({ error: "Authentication required" }, { status: 401 });

  const requestedSite = url.searchParams.get("siteId");
  const wantsCombined = requestedSite === null || requestedSite === "" || requestedSite === "all";

  try {
    const userId = viewer?.userId ?? "local-preview";
    const since = Math.floor(Date.now() / 1000) - rangeSeconds[range];
    const actionClause = type === "added" ? "AND a.action = 'load.added'" : type === "removed" ? "AND a.action = 'load.removed'" : "AND a.action IN ('load.added', 'load.removed')";

    // A load event names the *device* it happened on, so the site comes from a
    // join rather than the row itself. Without this, two inverters' events
    // arrive interleaved and unlabelled — "something switched on" with no way
    // to tell which half of the house it was.
    const known = await listSites(userId, { includeHidden: true }).catch(() => []);
    if (!wantsCombined && !known.some((site) => site.siteId === requestedSite)) {
      return NextResponse.json({ error: "That site does not belong to this account" }, { status: 404 });
    }
    const filters = ["a.user_id = ?", "a.created_at >= ?"];
    const bindings: Array<string | number> = [userId, since];
    if (!wantsCombined) { filters.push("d.site_id = ?"); bindings.push(requestedSite as string); }
    else {
      const visible = known.filter((site) => !site.hidden);
      if (visible.length === 0) filters.push("1 = 0");
      else {
        filters.push(`d.site_id IN (${visible.map(() => "?").join(", ")})`);
        bindings.push(...visible.map((site) => site.siteId));
      }
    }

    const result = await getD1().prepare(`
      SELECT a.id AS id, a.action AS action, a.detail_json AS detail_json, a.created_at AS created_at,
             d.site_id AS site_id, s.name AS site_name
      FROM audit_logs a
      LEFT JOIN devices d ON d.id = a.target_id
      LEFT JOIN sites s ON s.id = d.site_id
      WHERE ${filters.join(" AND ")} ${actionClause}
      ORDER BY a.created_at DESC
      LIMIT 200
    `).bind(...bindings).all<EventRow>();
    const displayNames = new Map(known.map((site) => [site.siteId, site.displayName]));
    const rows: EventRow[] = result.results ?? [];
    const events = rows.map((row) => {
      let detail: Record<string, unknown> = {};
      try { detail = row.detail_json ? JSON.parse(row.detail_json) as Record<string, unknown> : {}; } catch { /* Keep the event visible even if detail is malformed. */ }
      return {
        id: row.id, type: row.action === "load.added" ? "added" : "removed", occurredAt: new Date(row.created_at * 1000).toISOString(),
        beforeW: Number(detail.beforeW) || 0, afterW: Number(detail.afterW) || 0, deltaW: Number(detail.deltaW) || 0,
        confidence: typeof detail.confidence === "string" ? detail.confidence : "unknown",
        siteId: row.site_id,
        // Prefer the owner's chosen name over whatever the provider called the
        // station when the event was recorded.
        stationName: (row.site_id ? displayNames.get(row.site_id) : null) ?? row.site_name ?? (typeof detail.stationName === "string" ? detail.stationName : "Home"),
        sampleWindowSeconds: Number(detail.sampleWindowSeconds) || null,
      };
    });
    const added = events.filter((event) => event.type === "added");
    const removed = events.filter((event) => event.type === "removed");
    return NextResponse.json({ range, type, siteId: wantsCombined ? "all" : requestedSite, events, summary: { total: events.length, added: added.length, removed: removed.length, netChangeW: events.reduce((sum, event) => sum + event.deltaW, 0), largestChangeW: events.reduce((largest, event) => Math.max(largest, Math.abs(event.deltaW)), 0) } }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Load events are unavailable";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
