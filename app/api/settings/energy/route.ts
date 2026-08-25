import { NextResponse } from "next/server";
import { isLocalPreview } from "../../../request-origin";
import { getChatGPTUser } from "../../../chatgpt-auth";
import { getD1 } from "../../../../db";
import { listSites } from "../../../../lib/accounts";

export const dynamic = "force-dynamic";

type SettingsRow = { currency: string; import_tariff_per_kwh: number | null; export_credit_per_kwh: number | null; inverter_capacity_w: number; solar_capacity_w: number; grid_export_offset: number; solar_panel_cost: number; inverter_battery_cost: number; installation_cost: number; updated_at: number };

async function identity(request: Request) {
  const viewer = await getChatGPTUser();
  const isLocal = isLocalPreview(new URL(request.url).hostname);
  return viewer ?? (isLocal ? { userId: "local-preview", email: "local@gridline.invalid", displayName: "Local owner", fullName: null } : null);
}

function response(row?: SettingsRow) {
  return {
    currency: row?.currency ?? "PKR", importTariffPerKwh: row?.import_tariff_per_kwh ?? 63,
    exportCreditPerKwh: row?.export_credit_per_kwh ?? 0, inverterCapacityW: row?.inverter_capacity_w ?? 4000,
    solarCapacityW: row?.solar_capacity_w ?? 4680, gridExportOffset: row?.grid_export_offset ?? 2,
    solarPanelCost: row?.solar_panel_cost ?? 218440, inverterBatteryCost: row?.inverter_battery_cost ?? 233000,
    installationCost: row?.installation_cost ?? 181500, totalSystemCost: (row?.solar_panel_cost ?? 218440) + (row?.inverter_battery_cost ?? 233000) + (row?.installation_cost ?? 181500),
    configured: true,
    updatedAt: row ? new Date(row.updated_at * 1000).toISOString() : null,
  };
}

export async function GET(request: Request) {
  const viewer = await identity(request);
  if (!viewer) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  try {
    const requestedSite = new URL(request.url).searchParams.get("siteId");
    const siteId = requestedSite && requestedSite !== "all" ? requestedSite : null;
    if (siteId) {
      const known = await listSites(viewer.userId, { includeHidden: true }).catch(() => []);
      if (!known.some((site) => site.siteId === siteId)) return NextResponse.json({ error: "That site does not belong to this account" }, { status: 404 });
    }
    const db = getD1();
    const columns = "currency, import_tariff_per_kwh, export_credit_per_kwh, inverter_capacity_w, solar_capacity_w, grid_export_offset, solar_panel_cost, inverter_battery_cost, installation_cost, updated_at";
    const siteRow = siteId
      ? await db.prepare(`SELECT ${columns} FROM energy_settings WHERE user_id = ? AND site_id = ?`).bind(viewer.userId, siteId).first<SettingsRow>()
      : null;
    const row = siteRow ?? await db.prepare(`SELECT ${columns} FROM energy_settings WHERE user_id = ? AND site_id IS NULL`).bind(viewer.userId).first<SettingsRow>();
    return NextResponse.json(response(row ?? undefined), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Energy settings are unavailable";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

export async function PUT(request: Request) {
  const viewer = await identity(request);
  if (!viewer) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  try {
    const requestedSite = new URL(request.url).searchParams.get("siteId");
    const siteId = requestedSite && requestedSite !== "all" ? requestedSite : null;
    if (siteId) {
      const known = await listSites(viewer.userId, { includeHidden: true }).catch(() => []);
      if (!known.some((site) => site.siteId === siteId)) return NextResponse.json({ error: "That site does not belong to this account" }, { status: 404 });
    }
    const body = await request.json() as Record<string, unknown>;
    const importRate = Number(body.importTariffPerKwh);
    const exportRate = body.exportCreditPerKwh === "" || body.exportCreditPerKwh === null ? null : Number(body.exportCreditPerKwh);
    const inverterCapacityW = Number(body.inverterCapacityW);
    const solarCapacityW = Number(body.solarCapacityW);
    const gridExportOffset = Number(body.gridExportOffset);
    const solarPanelCost = Number(body.solarPanelCost), inverterBatteryCost = Number(body.inverterBatteryCost), installationCost = Number(body.installationCost);
    if (!Number.isFinite(importRate) || importRate < 0 || importRate > 500 || (exportRate !== null && (!Number.isFinite(exportRate) || exportRate < 0 || exportRate > 500))) return NextResponse.json({ error: "Tariff values must be between 0 and 500 PKR/kWh" }, { status: 400 });
    if (!Number.isFinite(inverterCapacityW) || inverterCapacityW < 100 || inverterCapacityW > 100_000 || !Number.isFinite(solarCapacityW) || solarCapacityW < 100 || solarCapacityW > 100_000) return NextResponse.json({ error: "System capacities must be between 100 W and 100 kW" }, { status: 400 });
    if (!Number.isFinite(gridExportOffset) || gridExportOffset < 0 || gridExportOffset > 100) return NextResponse.json({ error: "Grid export offset must be between 0 and 100" }, { status: 400 });
    if (![solarPanelCost, inverterBatteryCost, installationCost].every((value) => Number.isFinite(value) && value >= 0 && value <= 100_000_000)) return NextResponse.json({ error: "System costs must be valid positive amounts" }, { status: 400 });
    const now = Math.floor(Date.now() / 1000);
    const db = getD1();
    const settingsWrite = siteId
      ? db.prepare("INSERT INTO energy_settings (user_id, site_id, currency, import_tariff_per_kwh, export_credit_per_kwh, inverter_capacity_w, solar_capacity_w, grid_export_offset, solar_panel_cost, inverter_battery_cost, installation_cost, updated_at) VALUES (?, ?, 'PKR', ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, site_id) DO UPDATE SET import_tariff_per_kwh = excluded.import_tariff_per_kwh, export_credit_per_kwh = excluded.export_credit_per_kwh, inverter_capacity_w = excluded.inverter_capacity_w, solar_capacity_w = excluded.solar_capacity_w, grid_export_offset = excluded.grid_export_offset, solar_panel_cost = excluded.solar_panel_cost, inverter_battery_cost = excluded.inverter_battery_cost, installation_cost = excluded.installation_cost, updated_at = excluded.updated_at").bind(viewer.userId, siteId, importRate, exportRate, inverterCapacityW, solarCapacityW, gridExportOffset, solarPanelCost, inverterBatteryCost, installationCost, now)
      : db.prepare("INSERT INTO energy_settings (user_id, site_id, currency, import_tariff_per_kwh, export_credit_per_kwh, inverter_capacity_w, solar_capacity_w, grid_export_offset, solar_panel_cost, inverter_battery_cost, installation_cost, updated_at) VALUES (?, NULL, 'PKR', ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id) WHERE site_id IS NULL DO UPDATE SET import_tariff_per_kwh = excluded.import_tariff_per_kwh, export_credit_per_kwh = excluded.export_credit_per_kwh, inverter_capacity_w = excluded.inverter_capacity_w, solar_capacity_w = excluded.solar_capacity_w, grid_export_offset = excluded.grid_export_offset, solar_panel_cost = excluded.solar_panel_cost, inverter_battery_cost = excluded.inverter_battery_cost, installation_cost = excluded.installation_cost, updated_at = excluded.updated_at").bind(viewer.userId, importRate, exportRate, inverterCapacityW, solarCapacityW, gridExportOffset, solarPanelCost, inverterBatteryCost, installationCost, now);
    await db.batch([
      db.prepare("INSERT INTO users (id, email, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET email = excluded.email, display_name = excluded.display_name, updated_at = excluded.updated_at").bind(viewer.userId, viewer.email, viewer.displayName, now, now),
      settingsWrite,
    ]);
    return NextResponse.json({ ...response({ currency: "PKR", import_tariff_per_kwh: importRate, export_credit_per_kwh: exportRate, inverter_capacity_w: inverterCapacityW, solar_capacity_w: solarCapacityW, grid_export_offset: gridExportOffset, solar_panel_cost: solarPanelCost, inverter_battery_cost: inverterBatteryCost, installation_cost: installationCost, updated_at: now }), saved: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Energy settings could not be saved";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
