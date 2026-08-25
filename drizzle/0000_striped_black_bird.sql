CREATE TABLE `alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`severity` text NOT NULL,
	`title` text NOT NULL,
	`message` text,
	`occurred_at` integer NOT NULL,
	`acknowledged_at` integer,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_alerts_site_occurred` ON `alerts` (`site_id`,`occurred_at`);--> statement-breakpoint
CREATE TABLE `audit_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`action` text NOT NULL,
	`target_type` text,
	`target_id` text,
	`detail_json` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_audit_user_created` ON `audit_logs` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `automations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`site_id` text NOT NULL,
	`name` text NOT NULL,
	`trigger_type` text NOT NULL,
	`action_type` text NOT NULL,
	`config_json` text NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_automations_user_site` ON `automations` (`user_id`,`site_id`);--> statement-breakpoint
CREATE TABLE `devices` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`provider_device_sn` text,
	`product_model` text,
	`category_code` text,
	`status` text DEFAULT 'unknown' NOT NULL,
	`last_seen_at` integer,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_devices_site_id` ON `devices` (`site_id`);--> statement-breakpoint
CREATE TABLE `provider_accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`provider` text DEFAULT 'itel' NOT NULL,
	`external_user_id` text,
	`encrypted_access_token` text,
	`encrypted_refresh_token` text,
	`token_expires_at` integer,
	`status` text DEFAULT 'not_connected' NOT NULL,
	`last_sync_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_provider_user_provider` ON `provider_accounts` (`user_id`,`provider`);--> statement-breakpoint
CREATE TABLE `raw_provider_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`site_id` text,
	`source` text NOT NULL,
	`topic_or_path` text NOT NULL,
	`payload_json` text NOT NULL,
	`received_at` integer NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_raw_events_site_received` ON `raw_provider_events` (`site_id`,`received_at`);--> statement-breakpoint
CREATE TABLE `sites` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`provider_station_id` text,
	`name` text NOT NULL,
	`timezone` text DEFAULT 'Asia/Karachi' NOT NULL,
	`status` text DEFAULT 'unknown' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_sites_user_id` ON `sites` (`user_id`);--> statement-breakpoint
CREATE TABLE `telemetry` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`site_id` text NOT NULL,
	`device_id` text NOT NULL,
	`recorded_at` integer NOT NULL,
	`provider_reported_at` integer,
	`source` text NOT NULL,
	`pv_power_w` real,
	`load_power_w` real,
	`grid_power_w` real,
	`battery_power_w` real,
	`battery_soc_percent` real,
	`generator_power_w` real,
	`online` integer,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_telemetry_site_recorded` ON `telemetry` (`site_id`,`recorded_at`);--> statement-breakpoint
CREATE INDEX `idx_telemetry_device_recorded` ON `telemetry` (`device_id`,`recorded_at`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`display_name` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_users_email` ON `users` (`email`);
--> statement-breakpoint
PRAGMA optimize;
