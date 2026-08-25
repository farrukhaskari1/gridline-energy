CREATE TABLE `energy_settings` (
	`user_id` text PRIMARY KEY NOT NULL,
	`currency` text DEFAULT 'PKR' NOT NULL,
	`import_tariff_per_kwh` real,
	`export_credit_per_kwh` real,
	`inverter_capacity_w` real DEFAULT 4000 NOT NULL,
	`solar_capacity_w` real DEFAULT 4680 NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
