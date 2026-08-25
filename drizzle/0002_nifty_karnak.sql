ALTER TABLE `energy_settings` ADD `grid_export_offset` real DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE `energy_settings` ADD `solar_panel_cost` real DEFAULT 218440 NOT NULL;--> statement-breakpoint
ALTER TABLE `energy_settings` ADD `inverter_battery_cost` real DEFAULT 233000 NOT NULL;--> statement-breakpoint
ALTER TABLE `energy_settings` ADD `installation_cost` real DEFAULT 181500 NOT NULL;