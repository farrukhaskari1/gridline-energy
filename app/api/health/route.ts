import { NextResponse } from "next/server";

export function GET() {
  return NextResponse.json({ service: "gridline", status: "ok", collectorConfigured: Boolean(process.env.ITEL_USERNAME && process.env.ITEL_PASSWORD), timestamp: new Date().toISOString() });
}
