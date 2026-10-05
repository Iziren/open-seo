CREATE TABLE `seo_drift_baselines` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `seo_drift_baselines_project_id_idx` ON `seo_drift_baselines` (`project_id`);--> statement-breakpoint
CREATE TABLE `seo_drift_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`baseline_id` text NOT NULL,
	`url` text NOT NULL,
	`field` text NOT NULL,
	`old_value` text,
	`new_value` text,
	`change_type` text NOT NULL,
	`severity` text NOT NULL,
	`detected_at` text DEFAULT (current_timestamp) NOT NULL,
	`resolved_at` text,
	FOREIGN KEY (`baseline_id`) REFERENCES `seo_drift_baselines`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `seo_drift_changes_baseline_id_idx` ON `seo_drift_changes` (`baseline_id`);--> statement-breakpoint
CREATE INDEX `seo_drift_changes_url_idx` ON `seo_drift_changes` (`url`);--> statement-breakpoint
CREATE TABLE `seo_drift_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`baseline_id` text NOT NULL,
	`url` text NOT NULL,
	`canonical_url` text,
	`title` text,
	`meta_description` text,
	`h1` text,
	`schema_json_ld` text,
	`robots_meta` text,
	`status_code` integer,
	`indexable` integer DEFAULT true NOT NULL,
	`word_count` integer DEFAULT 0 NOT NULL,
	`external_link_count` integer DEFAULT 0 NOT NULL,
	`headers_json` text,
	`captured_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`baseline_id`) REFERENCES `seo_drift_baselines`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `seo_drift_snapshots_baseline_url_idx` ON `seo_drift_snapshots` (`baseline_id`,`url`);--> statement-breakpoint
CREATE INDEX `seo_drift_snapshots_url_idx` ON `seo_drift_snapshots` (`url`);