const BASE_URL = "https://energy-api.dyque.com";

type Envelope<T> = { flag?: number | string; msg?: string | null; ret?: T | null };
type LoginResult = { accessToken: string; refreshToken: string; expireIn: number; userId: number };

export type ItelStation = { stationId: number; stationName: string; timezone?: string; timeZone?: string; latitude?: number | string; longitude?: number | string; lat?: number | string; lng?: number | string };
export type ItelDevice = { deviceSn: string; productModel?: string; categoryCode?: string; onlineStatus?: number };
export type ItelFlow = {
  pvPower?: number; loadPower?: number; gridPower?: number; batteryPower?: number; batterySoc?: number;
  genPower?: number; reportTime?: string; timezone?: string; mqttStatus?: number; netStatus?: number;
};
export type ItelDashboard = {
  pvDischarge?: number; loadRecharge?: number; gridDischarge?: number; gridRecharge?: number;
  batteryRecharge?: number; batteryDischarge?: number;
};

export class ItelError extends Error {
  readonly unauthorized: boolean;
  constructor(message: string, unauthorized = false) {
    super(message);
    this.name = "ItelError";
    this.unauthorized = unauthorized;
  }
}

/**
 * These were single slots keyed on "whichever username called last". With more
 * than one account that is a cache that is always wrong: two logins polling in
 * turn evict each other every request, and — worse — account B could read back
 * account A's token. They are maps now, keyed by username for the session and
 * by `username|stationId` for discovery.
 */
type CachedSession = { accessToken: string; expiresAt: number };
type CachedDiscovery = { station: ItelStation; device: ItelDevice; expiresAt: number };

const cachedSessions = new Map<string, CachedSession>();
const cachedDiscoveries = new Map<string, CachedDiscovery>();

const DISCOVERY_TTL_MS = 5 * 60_000;
const AUTH_HINT = /token|login|auth|expire|credential|unauthor|session/i;

function looksUnauthorized(status: number, flag: unknown, message: string | null | undefined) {
  if (status === 401 || status === 403) return true;
  const flagText = flag === undefined || flag === null ? "" : String(flag);
  if (flagText === "401" || flagText === "403") return true;
  return typeof message === "string" && AUTH_HINT.test(message);
}

async function request<T>(path: string, init: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, { ...init, signal: AbortSignal.timeout(20_000) });
  } catch (error) {
    const reason = error instanceof Error && error.name === "TimeoutError" ? "timed out" : "could not be reached";
    throw new ItelError(`iTel ${reason} (${path.split("?")[0]})`);
  }

  const raw = await response.text();
  let data: Envelope<T>;
  try {
    data = JSON.parse(raw) as Envelope<T>;
  } catch {
    // A gateway or captive-portal HTML body must not surface as a JSON parse error.
    throw new ItelError(`iTel returned a non-JSON response (HTTP ${response.status})`);
  }

  // `ret` is absent — not just null — on several provider error shapes, so a
  // strict `=== null` check silently returned undefined to the caller.
  if (!response.ok || data.ret == null) {
    const message = data.msg || `iTel request failed (HTTP ${response.status}, flag ${data.flag ?? "none"})`;
    throw new ItelError(message, looksUnauthorized(response.status, data.flag, data.msg));
  }
  return data.ret;
}

export async function loginItel(username: string, password: string) {
  return request<LoginResult>("/esp/user-center/auth/user/login", {
    method: "POST",
    headers: { "Accept": "application/json", "APP-Brand": "itel", "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
}

/** Drops one account's cached token, or every account's when called bare. */
export function invalidateItelSession(username?: string) {
  if (username === undefined) {
    cachedSessions.clear();
    cachedDiscoveries.clear();
    return;
  }
  cachedSessions.delete(username);
  for (const key of [...cachedDiscoveries.keys()]) {
    if (key === username || key.startsWith(`${username}|`)) cachedDiscoveries.delete(key);
  }
}

export async function getItelSession(username: string, password: string) {
  const cached = cachedSessions.get(username);
  if (cached && cached.expiresAt - 60_000 > Date.now()) return { accessToken: cached.accessToken };
  const session = await loginItel(username, password);
  cachedSessions.set(username, {
    accessToken: session.accessToken,
    expiresAt: Date.now() + Math.max(60, Number(session.expireIn) || 3600) * 1000,
  });
  return { accessToken: session.accessToken };
}

/**
 * Runs an authenticated call and, when iTel rejects the cached token (it can be
 * revoked server-side when the phone app signs in), logs in once more and
 * retries. Without this the whole portal stayed stale until the process
 * restarted.
 */
export async function withItelAuth<T>(username: string, password: string, run: (accessToken: string) => Promise<T>): Promise<T> {
  const session = await getItelSession(username, password);
  try {
    return await run(session.accessToken);
  } catch (error) {
    if (!(error instanceof ItelError) || !error.unauthorized) throw error;
    invalidateItelSession(username);
    const retry = await getItelSession(username, password);
    return run(retry.accessToken);
  }
}

function authHeaders(accessToken: string) {
  return { "Accept": "application/json", "APP-Brand": "itel", "App-Code": "itel", "access-token": accessToken };
}

export async function getStations(accessToken: string) {
  return request<ItelStation[]>("/energy/appliance/app/v1/station", { headers: authHeaders(accessToken) });
}

export async function getDevices(accessToken: string, stationId: number) {
  const payload = await request<Array<{ deviceInfoList?: ItelDevice[] }>>(`/energy/appliance/app/v1/home/devices?stationId=${stationId}`, { headers: authHeaders(accessToken) });
  return payload.flatMap((station) => station.deviceInfoList ?? []);
}

/**
 * Station and inverter identity never change between polls, so caching them
 * removes two of the four provider calls made every ten seconds.
 */
export async function discoverStationAndDevice(accessToken: string, username: string, stationId?: number, deviceSn?: string) {
  const key = stationId === undefined ? username : `${username}|${stationId}`;
  const cached = cachedDiscoveries.get(key);
  if (cached && cached.expiresAt > Date.now()) return { station: cached.station, device: cached.device };

  const stations = await getStations(accessToken);
  // A login can own several stations. Picking `[0]` was fine while one account
  // meant one inverter; now the caller names the station it wants and only
  // falls back to the first when it has not been told.
  const station = stationId === undefined ? stations[0] : stations.find((candidate) => Number(candidate.stationId) === Number(stationId));
  if (!station) {
    throw new ItelError(stationId === undefined ? "No iTel station was returned" : `iTel station ${stationId} is not on this account`);
  }
  const devices = await getDevices(accessToken, station.stationId);
  const device = deviceSn === undefined ? devices[0] : devices.find((candidate) => candidate.deviceSn === deviceSn) ?? devices[0];
  if (!device) throw new ItelError("No iTel device was returned");
  cachedDiscoveries.set(key, { station, device, expiresAt: Date.now() + DISCOVERY_TTL_MS });
  return { station, device };
}

/** Every station on a login, used when adding an account so the operator can pick. */
export async function listStationsWithDevices(accessToken: string) {
  const stations = await getStations(accessToken);
  return Promise.all(stations.map(async (station) => ({
    station,
    devices: await getDevices(accessToken, station.stationId).catch(() => [] as ItelDevice[]),
  })));
}

/**
 * The flow service reports power in kilowatts, but the stored telemetry column,
 * the load-change threshold and every kWh total downstream are in watts.
 * Confirmed against the provider's own responses captured at the same instant:
 * `/home/flow` reported loadPower 1.03 while `/real-time-data` reported
 * "Load Active Power:,1029W".
 *
 * No domestic inverter delivers 200 kW, so anything above that was already sent
 * in watts and is left alone.
 */
const ALREADY_WATTS_THRESHOLD = 200;

function negate(value: number | undefined) { return typeof value === "number" && Number.isFinite(value) ? -value : value; }

function wattsFromKilowatts(value: number | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.abs(value) > ALREADY_WATTS_THRESHOLD ? value : value * 1_000;
}

export async function getEnergyFlow(accessToken: string, stationId: number, deviceSn: string) {
  const query = new URLSearchParams({ stationId: String(stationId), deviceSn });
  const flow = await request<ItelFlow>(`/energy/appliance/app/v1/home/flow?${query}`, { headers: authHeaders(accessToken) });
  return {
    ...flow,
    pvPower: wattsFromKilowatts(flow.pvPower),
    loadPower: wattsFromKilowatts(flow.loadPower),
    gridPower: wattsFromKilowatts(flow.gridPower),
    // iTel reports battery power positive while CHARGING; the app convention is
    // positive = discharging to the home. Negate so charging/discharging, the
    // flow direction and the battery figures read correctly (matches the Swift
    // client and the provider app, which showed "Battery Charging" at +70 W).
    batteryPower: negate(wattsFromKilowatts(flow.batteryPower)),
    genPower: wattsFromKilowatts(flow.genPower),
  } satisfies ItelFlow;
}

export async function getDashboardEnergy(accessToken: string, stationId: number, device: ItelDevice) {
  const query = new URLSearchParams({
    stationId: String(stationId), deviceSn: device.deviceSn,
    categoryCode: device.categoryCode ?? "", dimension: "1",
  });
  return request<ItelDashboard>(`/energy/appliance/app/v2/dashboard?${query}`, { headers: authHeaders(accessToken) });
}

export async function getExtendedDeviceData(accessToken: string, stationId: number, deviceSn: string, categoryCode?: string) {
  const deviceQuery = new URLSearchParams({ stationId: String(stationId), deviceSn });
  const dashboardQuery = new URLSearchParams({
    stationId: String(stationId), deviceSn, categoryCode: categoryCode ?? "", dimension: "2",
  });
  // `device-datas` rejects GET ("Request method 'GET' is not supported") and
  // wants the device fields under `param1`, like the statistics endpoints.
  const calls: ReadonlyArray<readonly [string, () => Promise<unknown>]> = [
    ["realTime", () => request<unknown>(`/energy/appliance/app/services/v2/real-time-data?${deviceQuery}`, { headers: authHeaders(accessToken) })],
    ["deviceData", () => postStat("/energy/appliance/app/services/v2/device-datas", accessToken, { stationId, deviceSn })],
    ["basicData", () => request<unknown>(`/energy/appliance/app/services/v2/basic-data?${deviceQuery}`, { headers: authHeaders(accessToken) })],
    ["dashboard", () => request<unknown>(`/energy/appliance/app/v2/dashboard?${dashboardQuery}`, { headers: authHeaders(accessToken) })],
  ];
  const results = await Promise.all(calls.map(async ([key, run]) => {
    try { return [key, { data: await run() }] as const; }
    catch (error) { return [key, { error: error instanceof Error ? error.message : "Unavailable" }] as const; }
  }));
  return Object.fromEntries(results) as Record<string, { data?: unknown; error?: string }>;
}

/* ------------------------------------------------------------------------- *
 * Period statistics (generation / consumption / grid / battery)
 *
 * These read the provider's own period counters instead of re-deriving energy
 * from polled power samples. Field names vary across Dyque firmware and brand
 * skins, so every figure is resolved by matching a leaf key against a list of
 * known aliases (confirmed from the iTel app binary) rather than a single
 * hard-coded path. A figure that cannot be found stays `null` — never a
 * confident zero.
 * ------------------------------------------------------------------------- */

export type StatDimension = "day" | "month" | "year" | "total";

/** Normalised energy figures for a period, all in kWh (or null when absent). */
export type ItelEnergyStat = {
  generationKwh: number | null;
  consumptionKwh: number | null;
  gridImportKwh: number | null;
  gridExportKwh: number | null;
  batteryChargeKwh: number | null;
  batteryDischargeKwh: number | null;
  selfConsumedKwh: number | null;
};

const STAT_ALIASES: Record<keyof ItelEnergyStat, string[]> = {
  // Leaf keys are compared lowercased with non-letters stripped.
  // Dashboard field names (pvDischarge / loadRecharge / gridDischarge /
  // gridRecharge / batteryRecharge / batteryDischarge) are included here too —
  // confirmed live against `/v2/dashboard` at dimension=2 (today), where
  // gridDischarge is grid IMPORT (grid → home) and gridRecharge is grid EXPORT.
  generationKwh: ["solargeneration", "pvgeneration", "pvdischarge", "generationenergy", "generatedenergy", "generation", "generated", "fromsolartotal", "pvenergy", "totalgeneration", "powergeneration", "pvyield", "yield"],
  consumptionKwh: ["consumptionenergy", "consumeenergy", "consumedenergy", "consumption", "consumed", "loadrecharge", "homeusage", "houseusage", "homeconsumption", "homeused", "loadenergy", "electricityconsumption", "loadconsumption", "usedenergy", "homeenergy"],
  gridImportKwh: ["gridimport", "gridimportenergy", "importenergy", "buyenergy", "boughtenergy", "gridbuy", "purchaseenergy", "purchasedelectricity", "fromgridtotal", "griddischarge", "gridpurchase", "boughtpower"],
  gridExportKwh: ["gridexport", "exportenergy", "sellenergy", "soldenergy", "gridsell", "feedin", "feedinenergy", "togridtotal", "gridrecharge", "gridpowersales", "soldpower"],
  batteryChargeKwh: ["batterycharge", "batteryrecharge", "chargeenergy", "chargedenergy", "cumulativechargeenergy", "bmstotalchargeenergy", "tobatterytotal", "totalchargeenergy"],
  batteryDischargeKwh: ["batterydischarge", "dischargeenergy", "dischargedenergy", "cumulativedischargeenergy", "bmstotaldischargeenergy", "frombatterytotal", "totaldischargeenergy"],
  selfConsumedKwh: ["selfconsumption", "selfconsumed", "selfuse", "selfuseenergy", "selfconsumedenergy"],
};

function normalizeLeaf(key: string) {
  const leaf = key.split(".").at(-1) ?? key;
  return leaf.toLowerCase().replace(/[^a-z]/g, "");
}

/** Flattens any provider payload to `[leaf, value]` numeric pairs, decoding the string-encoded numbers iTel sometimes returns. */
function flattenNumbers(value: unknown, prefix = "", out: Array<{ leaf: string; value: number }> = []): Array<{ leaf: string; value: number }> {
  if (out.length > 400 || value === null || value === undefined) return out;
  if (typeof value === "number") { if (Number.isFinite(value)) out.push({ leaf: normalizeLeaf(prefix), value }); return out; }
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    if (value.trim() !== "" && Number.isFinite(parsed)) out.push({ leaf: normalizeLeaf(prefix), value: parsed });
    return out;
  }
  if (Array.isArray(value)) { value.slice(0, 60).forEach((item, index) => flattenNumbers(item, `${prefix}[${index}]`, out)); return out; }
  if (typeof value === "object") { for (const [key, item] of Object.entries(value as Record<string, unknown>)) flattenNumbers(item, prefix ? `${prefix}.${key}` : key, out); }
  return out;
}

/** Resolves the normalised energy figures from a raw provider payload. */
export function normalizeEnergyStat(payload: unknown): ItelEnergyStat {
  const fields = flattenNumbers(payload);
  const pick = (aliases: string[]): number | null => {
    for (const alias of aliases) {
      const hit = fields.find((field) => field.leaf === alias);
      if (hit) return hit.value;
    }
    // Suffix match is a deliberate second pass: `todayPvGeneration` should still
    // resolve `pvgeneration` when no exact leaf exists.
    for (const alias of aliases) {
      const hit = fields.find((field) => field.leaf.endsWith(alias));
      if (hit) return hit.value;
    }
    return null;
  };
  const stat: ItelEnergyStat = {
    generationKwh: pick(STAT_ALIASES.generationKwh),
    consumptionKwh: pick(STAT_ALIASES.consumptionKwh),
    gridImportKwh: pick(STAT_ALIASES.gridImportKwh),
    gridExportKwh: pick(STAT_ALIASES.gridExportKwh),
    batteryChargeKwh: pick(STAT_ALIASES.batteryChargeKwh),
    batteryDischargeKwh: pick(STAT_ALIASES.batteryDischargeKwh),
    selfConsumedKwh: pick(STAT_ALIASES.selfConsumedKwh),
  };
  // Self-consumed is rarely reported directly; derive it when the parts exist:
  // everything generated that was not exported was consumed on-site.
  if (stat.selfConsumedKwh === null && stat.generationKwh !== null && stat.gridExportKwh !== null) {
    stat.selfConsumedKwh = Math.max(0, stat.generationKwh - stat.gridExportKwh);
  }
  return stat;
}

function statPath(base: string, params: Record<string, string | number | undefined>) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== "") query.set(key, String(value));
  const qs = query.toString();
  return qs ? `${base}?${qs}` : base;
}

/**
 * POSTs to a `/statistics` endpoint with the request body the current firmware
 * expects: the device/query fields nested under `param1`. Undefined fields are
 * dropped so the server sees a clean object.
 */
function postStat(path: string, accessToken: string, param1: Record<string, string | number | undefined>) {
  const body: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(param1)) if (value !== undefined && value !== "") body[key] = value;
  return request<unknown>(path, {
    method: "POST",
    headers: { ...authHeaders(accessToken), "Content-Type": "application/json" },
    body: JSON.stringify({ param1: body }),
  });
}

/* ------------------------------------------------------------------------- *
 * Dashboard-based period energy (the source the iTel app's cards use)
 *
 * `/v2/dashboard` is a plain GET that returns the same period totals shown on
 * the provider app's Today / Month / Year cards. The `dimension` code selects
 * the period. Confirmed live against the provider on 2026-08-20:
 *   dimension 2 → today   (pvDischarge 3.1, loadRecharge 9.5, gridDischarge 7.5)
 *   dimension 3 → month   (pvDischarge 259.4)
 *   dimension 4 → year    (pvDischarge 1405.7)
 *   dimension 1 → a multi-day rolling window (pvDischarge 9.4) — the value the
 *                 app showed before this fix, and why "today" did not match.
 * These are the authoritative day/month/year figures; the `/statistics` family
 * is kept only as a fallback for firmware that does not populate the dashboard.
 * ------------------------------------------------------------------------- */

const DASHBOARD_DIMENSION: Record<StatDimension, string> = { day: "2", month: "3", year: "4", total: "4" };

const numOrNull = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** Maps the dashboard's period counters onto the normalised energy figures. */
export function normalizeDashboardStat(dash: ItelDashboard): ItelEnergyStat {
  const generationKwh = numOrNull(dash.pvDischarge);
  const gridExportKwh = numOrNull(dash.gridRecharge);
  const stat: ItelEnergyStat = {
    generationKwh,
    consumptionKwh: numOrNull(dash.loadRecharge),
    gridImportKwh: numOrNull(dash.gridDischarge),
    gridExportKwh,
    batteryChargeKwh: numOrNull(dash.batteryRecharge),
    batteryDischargeKwh: numOrNull(dash.batteryDischarge),
    selfConsumedKwh: null,
  };
  if (generationKwh !== null && gridExportKwh !== null) stat.selfConsumedKwh = Math.max(0, generationKwh - gridExportKwh);
  return stat;
}

/** Period energy for a device from `/v2/dashboard` — matches the iTel app's cards. */
export async function getDashboardStat(
  accessToken: string,
  args: { stationId: number; deviceSn?: string; categoryCode?: string; dimension: StatDimension },
): Promise<ItelEnergyStat> {
  const query = new URLSearchParams({ stationId: String(args.stationId), dimension: DASHBOARD_DIMENSION[args.dimension] });
  if (args.deviceSn) query.set("deviceSn", args.deviceSn);
  if (args.categoryCode) query.set("categoryCode", args.categoryCode);
  const dash = await request<ItelDashboard>(`/energy/appliance/app/v2/dashboard?${query}`, { headers: authHeaders(accessToken) });
  return normalizeDashboardStat(dash);
}

/**
 * Period statistics for one device. `dimension` maps to the provider's
 * day/month/year/total bucketing; `date` anchors it (`YYYY-MM-DD`, `YYYY-MM`
 * or `YYYY`). Returns the normalised figures, or all-null when the provider
 * gives nothing usable.
 */
export async function getEnergyStatistics(
  accessToken: string,
  args: { stationId: number; deviceSn?: string; dimension: StatDimension; date?: string; timeZone?: string },
): Promise<ItelEnergyStat> {
  // The current firmware only answers `/v2/statistics` over POST — a GET returns
  // "Request method 'GET' is not supported" — and expects the device fields
  // nested under `param1` (confirmed from the server's own error, which names
  // `StatisticsV2ReqVO$Param1.getDeviceSn`).
  const payload = await postStat("/energy/appliance/app/v2/statistics", accessToken, {
    stationId: args.stationId, deviceSn: args.deviceSn, dateType: args.dimension, timeType: args.dimension, date: args.date, timeZone: args.timeZone,
  });
  return normalizeEnergyStat(payload);
}

/** Summary "cards" (Total Generated / Consumed). Same normaliser as statistics. */
export async function getStatisticsCard(accessToken: string, stationId: number, deviceSn?: string): Promise<ItelEnergyStat> {
  const payload = await postStat("/energy/appliance/app/v1/statistics/card", accessToken, { stationId, deviceSn });
  return normalizeEnergyStat(payload);
}

/** Grid import/export energy for a period. */
export async function getGridStatistics(
  accessToken: string,
  args: { stationId: number; deviceSn?: string; dimension: StatDimension; date?: string; timeZone?: string },
): Promise<Pick<ItelEnergyStat, "gridImportKwh" | "gridExportKwh">> {
  const payload = await postStat("/energy/appliance/app/v1/statistics/grid", accessToken, {
    stationId: args.stationId, deviceSn: args.deviceSn, dateType: args.dimension, date: args.date, timeZone: args.timeZone,
  });
  const stat = normalizeEnergyStat(payload);
  return { gridImportKwh: stat.gridImportKwh, gridExportKwh: stat.gridExportKwh };
}

/** Energy-flow report buckets (from-solar / from-grid / from-battery / to-grid / to-battery totals). */
export async function getReportFlow(
  accessToken: string,
  args: { stationId: number; deviceSn?: string; dimension: StatDimension; reportTime?: string; timeZone?: string },
): Promise<ItelEnergyStat> {
  // `/report-flow` answers GET but rejects a request that omits `deviceSn`
  // ("Field cannot be empty"), so the SN is required here.
  const params = { stationId: args.stationId, deviceSn: args.deviceSn, nodeType: "1", dateType: args.dimension, reportTime: args.reportTime, timeZone: args.timeZone };
  const payload = await request<unknown>(statPath("/energy/appliance/app/energy/report/report-flow", params), { headers: authHeaders(accessToken) });
  return normalizeEnergyStat(payload);
}

/* ------------------------------------------------------------------------- *
 * Alarms, battery capacity, tariff plan, station info
 * ------------------------------------------------------------------------- */

export type ItelAlarm = {
  id: string | null;
  severity: string;
  title: string;
  message: string | null;
  occurredAt: string | null;
};

const ALARM_SEVERITY = new Map<string, string>([
  ["1", "info"], ["2", "warning"], ["3", "critical"], ["4", "critical"],
  ["info", "info"], ["warn", "warning"], ["warning", "warning"], ["minor", "warning"],
  ["major", "critical"], ["critical", "critical"], ["fault", "critical"], ["error", "critical"],
]);

function pickString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of Object.keys(record)) {
    const leaf = key.toLowerCase().replace(/[^a-z]/g, "");
    if (keys.includes(leaf)) {
      const value = record[key];
      if (typeof value === "string" && value.trim() !== "") return value;
      if (typeof value === "number") return String(value);
    }
  }
  return null;
}

/** Provider alarms for a station, normalised to a stable shape. */
export async function getAlarms(accessToken: string, stationId: number, deviceSn?: string): Promise<ItelAlarm[]> {
  const payload = await request<unknown>(statPath("/energy/appliance/app/v1/alarms", { stationId, deviceSn }), { headers: authHeaders(accessToken) });
  const list: unknown[] = Array.isArray(payload)
    ? payload
    : (payload && typeof payload === "object" && Array.isArray((payload as { records?: unknown[] }).records))
      ? (payload as { records: unknown[] }).records
      : (payload && typeof payload === "object" && Array.isArray((payload as { list?: unknown[] }).list))
        ? (payload as { list: unknown[] }).list
        : [];
  return list.slice(0, 200).map((entry) => {
    const record = (entry && typeof entry === "object") ? entry as Record<string, unknown> : {};
    const rawSeverity = (pickString(record, ["level", "severity", "alarmlevel", "grade", "type"]) ?? "warning").toLowerCase();
    return {
      id: pickString(record, ["id", "alarmid", "uuid", "code", "eventid"]),
      severity: ALARM_SEVERITY.get(rawSeverity) ?? "warning",
      title: pickString(record, ["title", "name", "alarmname", "faultname", "eventname"]) ?? "Provider alarm",
      message: pickString(record, ["message", "content", "desc", "description", "detail", "remark"]),
      occurredAt: pickString(record, ["occurredat", "time", "alarmtime", "createtime", "happentime", "reporttime", "gmtcreate"]),
    } satisfies ItelAlarm;
  });
}

/** Usable battery capacity (kWh) the provider knows for a station, when it exposes it. */
export async function getStationBatteryCapacityKwh(accessToken: string, stationId: number, deviceSn?: string): Promise<number | null> {
  try {
    const payload = await request<unknown>(statPath("/energy/appliance/app/v1/station/battery-capacity", { stationId, deviceSn }), { headers: authHeaders(accessToken) });
    const fields = flattenNumbers(payload);
    const hit = fields.find((field) => ["batterycapacity", "capacity", "usablecapacity", "totalcapacity", "batterycapacitykwh"].includes(field.leaf))
      ?? fields.find((field) => field.leaf.includes("capacity"));
    if (!hit || !Number.isFinite(hit.value) || hit.value <= 0) return null;
    // Providers report capacity in kWh or Wh; anything over 1000 is Wh.
    return hit.value > 1000 ? hit.value / 1000 : hit.value;
  } catch { return null; }
}

/** Time-of-use import/export tariff the provider holds, when configured. Values are per-kWh in the plan's own currency. */
export type ItelTariff = { importPerKwh: number | null; exportPerKwh: number | null; currency: string | null };

export async function getTouTariff(accessToken: string, stationId: number, deviceSn?: string): Promise<ItelTariff> {
  try {
    const payload = await request<unknown>(statPath("/energy/appliance/app/v1/tou/price", { stationId, deviceSn }), { headers: authHeaders(accessToken) });
    const fields = flattenNumbers(payload);
    const pick = (aliases: string[]) => fields.find((field) => aliases.includes(field.leaf))?.value
      ?? fields.find((field) => aliases.some((alias) => field.leaf.endsWith(alias)))?.value ?? null;
    const currency = (payload && typeof payload === "object") ? pickString(payload as Record<string, unknown>, ["currency", "currencycode", "unit"]) : null;
    return {
      importPerKwh: pick(["price", "buyprice", "importprice", "purchaseprice", "electricityprice", "gridprice"]),
      exportPerKwh: pick(["sellprice", "exportprice", "feedinprice", "sellingprice"]),
      currency,
    };
  } catch { return { importPerKwh: null, exportPerKwh: null, currency: null }; }
}
