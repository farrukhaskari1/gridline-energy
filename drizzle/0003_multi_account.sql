DROP INDEX `idx_provider_user_provider`;--> statement-breakpoint
ALTER TABLE `provider_accounts` ADD `label` text;--> statement-breakpoint
ALTER TABLE `provider_accounts` ADD `encrypted_username` text;--> statement-breakpoint
ALTER TABLE `provider_accounts` ADD `encrypted_password` text;--> statement-breakpoint
ALTER TABLE `provider_accounts` ADD `credential_iv` text;--> statement-breakpoint
ALTER TABLE `provider_accounts` ADD `sort_order` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `provider_accounts` ADD `created_at` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_provider_user_provider_external` ON `provider_accounts` (`user_id`,`provider`,`external_user_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_energy_settings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`site_id` text,
	`currency` text DEFAULT 'PKR' NOT NULL,
	`import_tariff_per_kwh` real,
	`export_credit_per_kwh` real,
	`inverter_capacity_w` real DEFAULT 4000 NOT NULL,
	`solar_capacity_w` real DEFAULT 4680 NOT NULL,
	`grid_export_offset` real DEFAULT 2 NOT NULL,
	`solar_panel_cost` real DEFAULT 218440 NOT NULL,
	`inverter_battery_cost` real DEFAULT 233000 NOT NULL,
	`installation_cost` real DEFAULT 181500 NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
-- drizzle-kit generated `("id", "user_id", "site_id", ...) SELECT "id", ..., "site_id"`
-- here, but the old table has neither column: `user_id` was the primary key and
-- `site_id` is new. Selecting them fails with "no such column" and takes the
-- migration down with it. The surrogate id is left to AUTOINCREMENT and the
-- surviving row becomes the user-level default, which is what a null `site_id`
-- means.
INSERT INTO `__new_energy_settings`("user_id", "site_id", "currency", "import_tariff_per_kwh", "export_credit_per_kwh", "inverter_capacity_w", "solar_capacity_w", "grid_export_offset", "solar_panel_cost", "inverter_battery_cost", "installation_cost", "updated_at") SELECT "user_id", NULL, "currency", "import_tariff_per_kwh", "export_credit_per_kwh", "inverter_capacity_w", "solar_capacity_w", "grid_export_offset", "solar_panel_cost", "inverter_battery_cost", "installation_cost", "updated_at" FROM `energy_settings`;--> statement-breakpoint
DROP TABLE `energy_settings`;--> statement-breakpoint
ALTER TABLE `__new_energy_settings` RENAME TO `energy_settings`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_energy_settings_user_site` ON `energy_settings` (`user_id`,`site_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_energy_settings_user_default` ON `energy_settings` (`user_id`) WHERE `site_id` IS NULL;--> statement-breakpoint
ALTER TABLE `sites` ADD `provider_account_id` integer REFERENCES provider_accounts(id);--> statement-breakpoint
ALTER TABLE `sites` ADD `display_name` text;--> statement-breakpoint
ALTER TABLE `sites` ADD `battery_capacity_kwh` real;--> statement-breakpoint
ALTER TABLE `sites` ADD `sort_order` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `sites` ADD `hidden` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_sites_account` ON `sites` (`provider_account_id`);