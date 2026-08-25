import { NextResponse } from "next/server";
import { isLocalPreview } from "../../../request-origin";
import { getChatGPTUser } from "../../../chatgpt-auth";
import { ingestForUser } from "../../../../lib/ingest";

export const dynamic = "force-dynamic";

/**
 * Pulls the provider's authoritative period counters for every visible site and
 * persists day/month/year energy + savings, provider alarms, and any battery
 * capacity the provider knows but the operator has not entered. Safe to call on
 * a schedule (Cloudflare Cron Trigger, uptime pinger) or on demand.
 */
export async function POST(request: Request) {
  const url = new URL(request.url);
  const viewer = await getChatGPTUser();
  const isLocal = isLocalPreview(url.hostname);
  if (!viewer && !isLocal) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  const identity = {
    userId: viewer?.userId ?? "local-preview",
    email: viewer?.email ?? "local@gridline.invalid",
    displayName: viewer?.displayName ?? "Local owner",
  };
  try {
    const result = await ingestForUser(identity);
    return NextResponse.json({ ok: true, ...result }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Ingestion failed" }, { status: 502 });
  }
}
