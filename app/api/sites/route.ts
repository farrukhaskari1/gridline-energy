import { NextResponse } from "next/server";
import { isLocalPreview } from "../../request-origin";
import { getChatGPTUser } from "../../chatgpt-auth";
import { bootstrapFromEnvironment, listSites } from "../../../lib/accounts";

export const dynamic = "force-dynamic";

/**
 * The inverters this owner can look at, in the order they chose.
 *
 * Every scoped surface reads from here, so "which sites exist" has exactly one
 * answer and the selector cannot offer a site the API would then reject.
 */
export async function GET(request: Request) {
  const viewer = await getChatGPTUser();
  const isLocal = isLocalPreview(new URL(request.url).hostname);
  if (!viewer && !isLocal) return NextResponse.json({ error: "Authentication required" }, { status: 401 });

  const userId = viewer?.userId ?? "local-preview";
  try {
    // A deployment that already has ITEL_USERNAME / ITEL_PASSWORD adopts them
    // the first time its owner is seen, so nobody re-enters credentials the
    // server already holds. It is a no-op once any account exists.
    await bootstrapFromEnvironment(userId, viewer?.email ?? "local@gridline.invalid", viewer?.displayName ?? "Local owner");
    const sites = await listSites(userId, { includeHidden: true });
    return NextResponse.json({
      sites: sites.map((site) => ({
        siteId: site.siteId, displayName: site.displayName, providerName: site.providerName,
        accountId: site.accountId, accountLabel: site.accountLabel, stationId: site.stationId,
        batteryCapacityKWh: site.batteryCapacityKWh, sortOrder: site.sortOrder, hidden: site.hidden,
      })),
      visibleCount: sites.filter((site) => !site.hidden).length,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Sites are unavailable";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
