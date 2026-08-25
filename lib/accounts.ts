/**
 * Account and site registry.
 *
 * The portal used to have exactly one inverter, reached with `ITEL_USERNAME` /
 * `ITEL_PASSWORD` from the environment. It now has any number, and this module
 * is the single place that knows which credentials reach which station.
 *
 * Two shapes are supported and neither is privileged:
 *   - one login owning several stations -> one `provider_accounts` row, several `sites`
 *   - several separate logins            -> one `provider_accounts` row each
 *
 * Passwords live encrypted (see `lib/credentials.ts`) and are decrypted only
 * inside this module, on the way into an iTel call. Nothing here returns a
 * plaintext password to a route handler by accident: the only function that
 * exposes one is `credentialsForSite`, and it is named to say so.
 */

import { and, asc, eq } from "drizzle-orm";
import { getDb } from "../db";
import { devices, providerAccounts, sites, users } from "../db/schema";
import { decryptCredentials, encryptCredentials, credentialsConfigured, maskUsername } from "./credentials";
import { ItelError, listStationsWithDevices, loginItel } from "./itel";

export class AccountError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "AccountError";
    this.status = status;
  }
}

export type SiteRecord = {
  siteId: string;
  accountId: number | null;
  accountLabel: string | null;
  stationId: number | null;
  providerName: string;
  displayName: string;
  timezone: string;
  batteryCapacityKWh: number | null;
  sortOrder: number;
  hidden: boolean;
};

export type AccountRecord = {
  accountId: number;
  label: string;
  maskedUsername: string | null;
  hasStoredCredentials: boolean;
  sortOrder: number;
  siteCount: number;
};

/**
 * Site and device ids are derived, not random, so a re-sync of the same station
 * lands on the same row instead of forking history. The sync route used to own
 * a private copy of this; it is shared now precisely so bootstrapping an
 * account and syncing it cannot disagree about the id.
 */
export async function stableId(prefix: string, input: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return `${prefix}_${Array.from(new Uint8Array(bytes)).slice(0, 10).map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

export const siteIdFor = (userId: string, stationId: number | string) => stableId("site", `${userId}:${stationId}`);
export const deviceIdFor = (siteId: string, deviceSn: string) => stableId("device", `${siteId}:${deviceSn}`);

function environmentCredentials() {
  const username = process.env.ITEL_USERNAME;
  const password = process.env.ITEL_PASSWORD;
  return username && password ? { username, password } : null;
}

export async function listSites(userId: string, options: { includeHidden?: boolean } = {}): Promise<SiteRecord[]> {
  const db = getDb();
  const rows = await db
    .select({
      siteId: sites.id, accountId: sites.providerAccountId, accountLabel: providerAccounts.label,
      providerStationId: sites.providerStationId, name: sites.name, displayName: sites.displayName,
      timezone: sites.timezone, batteryCapacityKWh: sites.batteryCapacityKWh,
      sortOrder: sites.sortOrder, hidden: sites.hidden,
    })
    .from(sites)
    .leftJoin(providerAccounts, eq(sites.providerAccountId, providerAccounts.id))
    .where(eq(sites.userId, userId))
    .orderBy(asc(sites.sortOrder), asc(sites.name));

  return rows
    .filter((row) => options.includeHidden === true || !row.hidden)
    .map((row) => ({
      siteId: row.siteId,
      accountId: row.accountId ?? null,
      accountLabel: row.accountLabel ?? null,
      stationId: row.providerStationId === null ? null : Number(row.providerStationId),
      providerName: row.name,
      displayName: row.displayName?.trim() || row.name,
      timezone: row.timezone,
      batteryCapacityKWh: row.batteryCapacityKWh ?? null,
      sortOrder: row.sortOrder,
      hidden: Boolean(row.hidden),
    }));
}

export async function listAccounts(userId: string): Promise<AccountRecord[]> {
  const db = getDb();
  const rows = await db
    .select({
      accountId: providerAccounts.id, label: providerAccounts.label, externalUserId: providerAccounts.externalUserId,
      encryptedUsername: providerAccounts.encryptedUsername, encryptedPassword: providerAccounts.encryptedPassword,
      credentialIv: providerAccounts.credentialIv, sortOrder: providerAccounts.sortOrder,
    })
    .from(providerAccounts)
    .where(eq(providerAccounts.userId, userId))
    .orderBy(asc(providerAccounts.sortOrder), asc(providerAccounts.id));

  const siteRows = await db.select({ accountId: sites.providerAccountId }).from(sites).where(eq(sites.userId, userId));

  return Promise.all(rows.map(async (row) => {
    // The masked username is derived from the ciphertext, so a row written
    // under a rotated key degrades to "no masked name" instead of exploding.
    let masked: string | null = null;
    try {
      const plain = await decryptCredentials(row);
      masked = plain ? maskUsername(plain.username) : null;
    } catch {
      masked = null;
    }
    return {
      accountId: row.accountId,
      label: row.label?.trim() || `Account ${row.accountId}`,
      maskedUsername: masked,
      hasStoredCredentials: Boolean(row.encryptedUsername && row.encryptedPassword && row.credentialIv),
      sortOrder: row.sortOrder,
      siteCount: siteRows.filter((site) => site.accountId === row.accountId).length,
    };
  }));
}

/**
 * The credentials and provider identity needed to poll one site.
 *
 * Falls back to the environment for sites that predate multi-account, so an
 * existing deployment keeps working the moment this ships and before anyone
 * has added a second account.
 */
export async function credentialsForSite(userId: string, siteId: string) {
  const db = getDb();
  const row = (await db
    .select({
      providerStationId: sites.providerStationId, accountId: sites.providerAccountId,
      encryptedUsername: providerAccounts.encryptedUsername, encryptedPassword: providerAccounts.encryptedPassword,
      credentialIv: providerAccounts.credentialIv,
    })
    .from(sites)
    .leftJoin(providerAccounts, eq(sites.providerAccountId, providerAccounts.id))
    .where(and(eq(sites.id, siteId), eq(sites.userId, userId)))
    .limit(1))[0];
  if (!row) throw new AccountError("That site does not belong to this account", 404);

  const deviceRow = (await db
    .select({ deviceSn: devices.providerDeviceSn })
    .from(devices)
    .where(eq(devices.siteId, siteId))
    .limit(1))[0];

  const stored = row.accountId === null ? null : await decryptCredentials(row);
  const credentials = stored ?? environmentCredentials();
  if (!credentials) throw new AccountError("No credentials are stored for this site. Add the account again to reconnect it.", 409);

  return {
    username: credentials.username,
    password: credentials.password,
    stationId: row.providerStationId === null ? undefined : Number(row.providerStationId),
    deviceSn: deviceRow?.deviceSn ?? undefined,
  };
}

async function ensureUser(userId: string, email: string, displayName: string | null) {
  const now = new Date();
  await getDb().insert(users)
    .values({ id: userId, email, displayName, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: users.id, set: { email, displayName, updatedAt: now } });
}

export type AddAccountInput = {
  userId: string;
  email: string;
  displayName?: string | null;
  label?: string | null;
  username: string;
  password: string;
  batteryCapacityKWh?: number | null;
  /** Restrict to these station ids; omit to import every station on the login. */
  stationIds?: number[];
};

/**
 * Adds an account, but only after iTel has confirmed the credentials work.
 *
 * Validating before writing matters: a rejected login that still left a row
 * behind would poison every later poll with a 401 the operator cannot see the
 * cause of, and the encrypted password would be undeletable junk.
 */
export async function addAccount(input: AddAccountInput) {
  if (!credentialsConfigured()) {
    throw new AccountError("GRIDLINE_CREDENTIAL_KEY is not set on this deployment, so credentials cannot be stored securely", 503);
  }
  const username = input.username.trim();
  const password = input.password;
  if (!username || !password) throw new AccountError("A username and password are required");
  if (input.batteryCapacityKWh !== undefined && input.batteryCapacityKWh !== null) {
    if (!Number.isFinite(input.batteryCapacityKWh) || input.batteryCapacityKWh <= 0 || input.batteryCapacityKWh > 1_000) {
      throw new AccountError("Battery capacity must be between 0 and 1000 kWh");
    }
  }

  let session: Awaited<ReturnType<typeof loginItel>>;
  let discovered: Awaited<ReturnType<typeof listStationsWithDevices>>;
  try {
    session = await loginItel(username, password);
    discovered = await listStationsWithDevices(session.accessToken);
  } catch (error) {
    if (error instanceof ItelError && error.unauthorized) throw new AccountError("iTel rejected that username and password", 401);
    throw new AccountError(error instanceof Error ? error.message : "iTel could not be reached", 502);
  }

  const wanted = input.stationIds && input.stationIds.length > 0
    ? discovered.filter((entry) => input.stationIds!.some((id) => Number(id) === Number(entry.station.stationId)))
    : discovered;
  if (wanted.length === 0) throw new AccountError("That login has no stations to import", 422);

  const db = getDb();
  const externalUserId = String(session.userId);
  const existing = (await db.select({ id: providerAccounts.id })
    .from(providerAccounts)
    .where(and(eq(providerAccounts.userId, input.userId), eq(providerAccounts.provider, "itel"), eq(providerAccounts.externalUserId, externalUserId)))
    .limit(1))[0];

  await ensureUser(input.userId, input.email, input.displayName ?? null);

  const now = new Date();
  const encrypted = await encryptCredentials(username, password);
  const label = input.label?.trim() || discovered[0]?.station.stationName || maskUsername(username);

  let accountId: number;
  if (existing) {
    // Re-adding a known login is a credential refresh, not a duplicate.
    await db.update(providerAccounts)
      .set({ label, status: "active", ...encrypted })
      .where(eq(providerAccounts.id, existing.id));
    accountId = existing.id;
  } else {
    const maxOrder = (await db.select({ sortOrder: providerAccounts.sortOrder }).from(providerAccounts).where(eq(providerAccounts.userId, input.userId)))
      .reduce((highest, row) => Math.max(highest, row.sortOrder), -1);
    const inserted = await db.insert(providerAccounts)
      .values({ userId: input.userId, provider: "itel", externalUserId, label, status: "active", sortOrder: maxOrder + 1, createdAt: now, ...encrypted })
      .returning({ id: providerAccounts.id });
    accountId = inserted[0].id;
  }

  const existingSites = await db.select({ sortOrder: sites.sortOrder }).from(sites).where(eq(sites.userId, input.userId));
  let nextOrder = existingSites.reduce((highest, row) => Math.max(highest, row.sortOrder), -1) + 1;

  const imported: string[] = [];
  for (const entry of wanted) {
    const siteId = await siteIdFor(input.userId, entry.station.stationId);
    await db.insert(sites)
      .values({
        id: siteId, userId: input.userId, providerAccountId: accountId,
        providerStationId: String(entry.station.stationId), name: entry.station.stationName,
        timezone: entry.station.timeZone ?? entry.station.timezone ?? "Asia/Karachi", status: "unknown",
        batteryCapacityKWh: input.batteryCapacityKWh ?? null, sortOrder: nextOrder, hidden: false, createdAt: now,
      })
      // An existing site keeps its owner-chosen display name, order and
      // visibility — re-adding an account must not undo the operator's layout.
      .onConflictDoUpdate({
        target: sites.id,
        set: { providerAccountId: accountId, name: entry.station.stationName, ...(input.batteryCapacityKWh === undefined ? {} : { batteryCapacityKWh: input.batteryCapacityKWh }) },
      });
    nextOrder += 1;

    const device = entry.devices[0];
    if (device) {
      const deviceId = await deviceIdFor(siteId, device.deviceSn);
      await db.insert(devices)
        .values({ id: deviceId, siteId, providerDeviceSn: device.deviceSn, productModel: device.productModel, categoryCode: device.categoryCode, status: device.onlineStatus === 1 ? "online" : "unknown", lastSeenAt: now })
        .onConflictDoUpdate({ target: devices.id, set: { productModel: device.productModel, categoryCode: device.categoryCode } });
    }
    imported.push(siteId);
  }

  return { accountId, siteIds: imported, label };
}

/**
 * Forgets an account's credentials and hides its sites.
 *
 * The site rows are deliberately kept: telemetry, alerts and audit history all
 * reference them, and deleting the parent would either fail on the foreign key
 * or take the owner's history with it. Removing an account is a disconnect, not
 * a purge.
 */
export async function removeAccount(userId: string, accountId: number) {
  const db = getDb();
  const owned = (await db.select({ id: providerAccounts.id })
    .from(providerAccounts)
    .where(and(eq(providerAccounts.id, accountId), eq(providerAccounts.userId, userId)))
    .limit(1))[0];
  if (!owned) throw new AccountError("That account does not exist", 404);

  await db.update(sites).set({ hidden: true }).where(and(eq(sites.userId, userId), eq(sites.providerAccountId, accountId)));
  await db.update(providerAccounts)
    .set({ status: "disconnected", encryptedUsername: null, encryptedPassword: null, credentialIv: null, encryptedAccessToken: null, encryptedRefreshToken: null })
    .where(eq(providerAccounts.id, accountId));
  return { accountId };
}

export type SitePatch = { displayName?: string | null; batteryCapacityKWh?: number | null; sortOrder?: number; hidden?: boolean };

export async function updateSite(userId: string, siteId: string, patch: SitePatch) {
  const db = getDb();
  const owned = (await db.select({ id: sites.id }).from(sites).where(and(eq(sites.id, siteId), eq(sites.userId, userId))).limit(1))[0];
  if (!owned) throw new AccountError("That site does not belong to this account", 404);

  const changes: SitePatch = {};
  if (patch.displayName !== undefined) {
    const trimmed = patch.displayName?.trim() ?? "";
    if (trimmed.length > 60) throw new AccountError("A site name may be at most 60 characters");
    changes.displayName = trimmed.length > 0 ? trimmed : null;
  }
  if (patch.batteryCapacityKWh !== undefined) {
    const value = patch.batteryCapacityKWh;
    if (value !== null && (!Number.isFinite(value) || value <= 0 || value > 1_000)) throw new AccountError("Battery capacity must be between 0 and 1000 kWh");
    changes.batteryCapacityKWh = value;
  }
  if (patch.sortOrder !== undefined) {
    if (!Number.isInteger(patch.sortOrder) || patch.sortOrder < 0 || patch.sortOrder > 999) throw new AccountError("Sort order must be between 0 and 999");
    changes.sortOrder = patch.sortOrder;
  }
  if (patch.hidden !== undefined) changes.hidden = Boolean(patch.hidden);
  if (Object.keys(changes).length === 0) return { siteId, changed: false };

  await db.update(sites).set(changes).where(eq(sites.id, siteId));
  return { siteId, changed: true };
}

/**
 * Adopts the single environment-configured account the first time a signed-in
 * owner is seen, so nobody has to re-enter credentials the deployment already
 * holds. Silently does nothing when there is nothing to adopt, when accounts
 * already exist, or when no encryption key is configured — it runs on a hot
 * path and must never be the reason a page fails to load.
 */
export async function bootstrapFromEnvironment(userId: string, email: string, displayName?: string | null) {
  const environment = environmentCredentials();
  if (!environment || !credentialsConfigured()) return { bootstrapped: false as const };
  try {
    const db = getDb();
    const existing = await db.select({ id: providerAccounts.id }).from(providerAccounts).where(eq(providerAccounts.userId, userId)).limit(1);
    if (existing.length > 0) return { bootstrapped: false as const };
    const result = await addAccount({ userId, email, displayName, username: environment.username, password: environment.password });
    return { bootstrapped: true as const, ...result };
  } catch {
    return { bootstrapped: false as const };
  }
}
