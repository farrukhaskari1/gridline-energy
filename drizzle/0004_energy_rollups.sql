CREATE TABLE `energy_daily` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`site_id` text NOT NULL,
	`day` text NOT NULL,
	`generated_kwh` real,
	`consumed_kwh` real,
	`grid_import_kwh` real,
	`grid_export_kwh` real,
	`battery_charge_kwh` real,
	`battery_discharge_kwh` real,
	`self_consumed_kwh` real,
	`source` text DEFAULT 'provider' NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_energy_daily_site_day` ON `energy_daily` (`site_id`,`day`);--> statement-breakpoint
CREATE INDEX `idx_energy_daily_day` ON `energy_daily` (`day`);--> statement-breakpoint
CREATE TABLE `savings_rollup` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`site_id` text,
	`period_type` text NOT NULL,
	`period_key` text NOT NULL,
	`currency` text DEFAULT 'PKR' NOT NULL,
	`generated_kwh` real DEFAULT 0 NOT NULL,
	`consumed_kwh` real DEFAULT 0 NOT NULL,
	`grid_import_kwh` real DEFAULT 0 NOT NULL,
	`grid_export_kwh` real DEFAULT 0 NOT NULL,
	`self_consumed_kwh` real DEFAULT 0 NOT NULL,
	`estimated_savings` real DEFAULT 0 NOT NULL,
	`estimated_grid_cost` real DEFAULT 0 NOT NULL,
	`baseline_cost` real DEFAULT 0 NOT NULL,
	`tariff_import_per_kwh` real,
	`tariff_export_per_kwh` real,
	`source` text DEFAULT 'provider' NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_savings_site_period` ON `savings_rollup` (`user_id`,`site_id`,`period_type`,`period_key`) WHERE "savings_rollup"."site_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_savings_household_period` ON `savings_rollup` (`user_id`,`period_type`,`period_key`) WHERE "savings_rollup"."site_id" is null;--> statement-breakpoint
CREATE INDEX `idx_savings_user_period` ON `savings_rollup` (`user_id`,`period_type`,`period_key`);