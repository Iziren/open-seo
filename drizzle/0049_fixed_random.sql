ALTER TABLE `audit_pages` ADD `content_score` integer;--> statement-breakpoint
ALTER TABLE `audit_pages` ADD `schema_status` text;--> statement-breakpoint
ALTER TABLE `audit_pages` ADD `schema_types_json` text;--> statement-breakpoint
ALTER TABLE `audit_pages` ADD `schema_findings_json` text;--> statement-breakpoint
ALTER TABLE `audit_pages` ADD `nlp_summary_json` text;--> statement-breakpoint
ALTER TABLE `audits` ADD `health_score` integer;--> statement-breakpoint
ALTER TABLE `audits` ADD `score_breakdown` text;