import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(), email: text("email").notNull(), displayName: text("display_name"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(), updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
}, (table) => [uniqueIndex("idx_users_email").on(table.email)]);

/**
 * Capacities and costs. Previously one row per user, which cannot describe a
 * 4 kW and an 8 kW inverter at once.
 *
 * A null `siteId` is the user-level default a new site inherits until it is
 * given its own row, so the existing row survives the migration untouched.
 */
export const energySettings = sqliteTable("energy_settings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull().references(() => users.id),
  siteId: text("site_id"),
  currency: text("currency").notNull().default("PKR"),
  importTariffPerKwh: real("import_tariff_per_kwh"), exportCreditPerKwh: real("export_credit_per_kwh"),
  inverterCapacityW: real("inverter_capacity_w").notNull().default(4000), solarCapacityW: real("solar_capacity_w").notNull().default(4680),
  gridExportOffset: real("grid_export_offset").notNull().default(2),
  solarPanelCost: real("solar_panel_cost").notNull().default(218440),
  inverterBatteryCost: real("inverter_battery_cost").notNull().default(233000),
  installationCost: real("installation_cost").notNull().default(181500),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
}, (table) => [
  uniqueIndex("idx_energy_settings_user_site").on(table.userId, table.siteId),
  // SQLite treats NULLs as distinct inside a UNIQUE index, so the index above
  // does NOT stop a user from owning two rows with a null `site_id`. This
  // partial index does, and gives the upsert in /api/settings/energy a conflict
  // target it can name: `ON CONFLICT(user_id) WHERE site_id IS NULL`.
  uniqueIndex("idx_energy_settings_user_default").on(table.userId).where(sql`${table.siteId} is null`),
]);

/**
 * One set of provider credentials. A login owning several stations produces one
 * row here and several `sites`; separate logins produce one of each.
 *
 * The previous unique index was `(user_id, provider)` — one iTel account per
 * user, by construction. It becomes `(user_id, provider, external_user_id)`, so
 * the same login still cannot be added twice while different logins can.
 *
 * Credentials are AES-GCM encrypted; the key is the `GRIDLINE_CREDENTIAL_KEY`
 * secret and never leaves `lib/credentials.ts`.
 */
export const providerAccounts = sqliteTable("provider_accounts", {
  id: integer("id").primaryKey({ autoIncrement: true }), userId: text("user_id").notNull().references(() => users.id),
  provider: text("provider").notNull().default("itel"), externalUserId: text("external_user_id"),
  label: text("label"),
  encryptedUsername: text("encrypted_username"), encryptedPassword: text("encrypted_password"),
  credentialIv: text("credential_iv"),
  encryptedAccessToken: text("encrypted_access_token"), encryptedRefreshToken: text("encrypted_refresh_token"),
  tokenExpiresAt: integer("token_expires_at", { mode: "timestamp" }), status: text("status").notNull().default("not_connected"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp" }),
  lastSyncAt: integer("last_sync_at", { mode: "timestamp" }),
}, (table) => [uniqueIndex("idx_provider_user_provider_external").on(table.userId, table.provider, table.externalUserId)]);

export const sites = sqliteTable("sites", {
  id: text("id").primaryKey(), userId: text("user_id").notNull().references(() => users.id), providerStationId: text("provider_station_id"),
  /** Which credentials reach this site. Null only for rows predating multi-account. */
  providerAccountId: integer("provider_account_id").references(() => providerAccounts.id),
  name: text("name").notNull(),
  /** Owner-chosen name; falls back to the provider's `name`. */
  displayName: text("display_name"),
  timezone: text("timezone").notNull().default("Asia/Karachi"), status: text("status").notNull().default("unknown"),
  batteryCapacityKWh: real("battery_capacity_kwh"),
  sortOrder: integer("sort_order").notNull().default(0),
  hidden: integer("hidden", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
}, (table) => [index("idx_sites_user_id").on(table.userId), index("idx_sites_account").on(table.providerAccountId)]);

export const devices = sqliteTable("devices", {
  id: text("id").primaryKey(), siteId: text("site_id").notNull().references(() => sites.id), providerDeviceSn: text("provider_device_sn"),
  productModel: text("product_model"), categoryCode: text("category_code"), status: text("status").notNull().default("unknown"),
  lastSeenAt: integer("last_seen_at", { mode: "timestamp" }),
}, (table) => [index("idx_devices_site_id").on(table.siteId)]);

export const telemetry = sqliteTable("telemetry", {
  id: integer("id").primaryKey({ autoIncrement: true }), siteId: text("site_id").notNull().references(() => sites.id),
  deviceId: text("device_id").notNull().references(() => devices.id), recordedAt: integer("recorded_at", { mode: "timestamp" }).notNull(),
  providerReportedAt: integer("provider_reported_at", { mode: "timestamp" }), source: text("source").notNull(),
  pvPowerW: real("pv_power_w"), loadPowerW: real("load_power_w"), gridPowerW: real("grid_power_w"),
  batteryPowerW: real("battery_power_w"), batterySocPercent: real("battery_soc_percent"), generatorPowerW: real("generator_power_w"),
  online: integer("online", { mode: "boolean" }),
}, (table) => [index("idx_telemetry_site_recorded").on(table.siteId, table.recordedAt), index("idx_telemetry_device_recorded").on(table.deviceId, table.recordedAt)]);

export const alerts = sqliteTable("alerts", {
  id: text("id").primaryKey(), siteId: text("site_id").notNull().references(() => sites.id), severity: text("severity").notNull(),
  title: text("title").notNull(), message: text("message"), occurredAt: integer("occurred_at", { mode: "timestamp" }).notNull(),
  acknowledgedAt: integer("acknowledged_at", { mode: "timestamp" }),
}, (table) => [index("idx_alerts_site_occurred").on(table.siteId, table.occurredAt)]);

export const automations = sqliteTable("automations", {
  id: text("id").primaryKey(), userId: text("user_id").notNull().references(() => users.id), siteId: text("site_id").notNull().references(() => sites.id),
  name: text("name").notNull(), triggerType: text("trigger_type").notNull(), actionType: text("action_type").notNull(),
  configJson: text("config_json").notNull(), enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
}, (table) => [index("idx_automations_user_site").on(table.userId, table.siteId)]);

export const rawProviderEvents = sqliteTable("raw_provider_events", {
  id: integer("id").primaryKey({ autoIncrement: true }), siteId: text("site_id").references(() => sites.id), source: text("source").notNull(),
  topicOrPath: text("topic_or_path").notNull(), payloadJson: text("payload_json").notNull(), receivedAt: integer("received_at", { mode: "timestamp" }).notNull(),
}, (table) => [index("idx_raw_events_site_received").on(table.siteId, table.receivedAt)]);

export const auditLogs = sqliteTable("audit_logs", {
  id: integer("id").primaryKey({ autoIncrement: true }), userId: text("user_id").notNull(), action: text("action").notNull(),
  targetType: text("target_type"), targetId: text("target_id"), detailJson: text("detail_json"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
}, (table) => [index("idx_audit_user_created").on(table.userId, table.createdAt)]);

/**
 * Authoritative per-day energy, sourced from the provider's own period counters
 * (Dyque `/statistics`, `/report-flow`), not reconstructed from polled power
 * samples. One row per (site, day). `source` records where the numbers came
 * from — "provider" when the counters were read, "samples" when we had to fall
 * back to integrating telemetry because the provider was unreachable — so a
 * degraded day is never silently presented as authoritative.
 *
 * `day` is a UTC-anchored `YYYY-MM-DD` string in the site's own timezone-day,
 * chosen so month/year roll-ups are a cheap string prefix match and never a
 * timezone re-bucketing.
 */
export const energyDaily = sqliteTable("energy_daily", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  siteId: text("site_id").notNull().references(() => sites.id),
  day: text("day").notNull(),
  generatedKwh: real("generated_kwh"),
  consumedKwh: real("consumed_kwh"),
  gridImportKwh: real("grid_import_kwh"),
  gridExportKwh: real("grid_export_kwh"),
  batteryChargeKwh: real("battery_charge_kwh"),
  batteryDischargeKwh: real("battery_discharge_kwh"),
  selfConsumedKwh: real("self_consumed_kwh"),
  source: text("source").notNull().default("provider"),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
}, (table) => [
  uniqueIndex("idx_energy_daily_site_day").on(table.siteId, table.day),
  index("idx_energy_daily_day").on(table.day),
]);

/**
 * Persisted money savings for a period, so "this month" and "this year" are a
 * stored fact rather than a figure recomputed from raw samples on every page
 * load. `periodType` is `day` | `month` | `year`; `periodKey` is `YYYY-MM-DD`,
 * `YYYY-MM` or `YYYY` respectively. `siteId` is null for the household total
 * across every visible inverter.
 *
 * The money columns are snapshots under the tariff in effect when the roll-up
 * ran (`tariffImportPerKwh` / `tariffExportPerKwh` record it), because a later
 * tariff edit must not silently rewrite a month already reported to the owner.
 */
export const savingsRollup = sqliteTable("savings_rollup", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull().references(() => users.id),
  siteId: text("site_id").references(() => sites.id),
  periodType: text("period_type").notNull(),
  periodKey: text("period_key").notNull(),
  currency: text("currency").notNull().default("PKR"),
  generatedKwh: real("generated_kwh").notNull().default(0),
  consumedKwh: real("consumed_kwh").notNull().default(0),
  gridImportKwh: real("grid_import_kwh").notNull().default(0),
  gridExportKwh: real("grid_export_kwh").notNull().default(0),
  selfConsumedKwh: real("self_consumed_kwh").notNull().default(0),
  estimatedSavings: real("estimated_savings").notNull().default(0),
  estimatedGridCost: real("estimated_grid_cost").notNull().default(0),
  baselineCost: real("baseline_cost").notNull().default(0),
  tariffImportPerKwh: real("tariff_import_per_kwh"),
  tariffExportPerKwh: real("tariff_export_per_kwh"),
  source: text("source").notNull().default("provider"),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
}, (table) => [
  // A named site: (user, site, type, key) is unique. SQLite treats NULLs as
  // distinct inside a UNIQUE index, so this does NOT constrain household rows
  // (site_id IS NULL) — the two partial indexes below do, and give the upserts
  // a conflict target they can name.
  uniqueIndex("idx_savings_site_period").on(table.userId, table.siteId, table.periodType, table.periodKey).where(sql`${table.siteId} is not null`),
  uniqueIndex("idx_savings_household_period").on(table.userId, table.periodType, table.periodKey).where(sql`${table.siteId} is null`),
  index("idx_savings_user_period").on(table.userId, table.periodType, table.periodKey),
]);
