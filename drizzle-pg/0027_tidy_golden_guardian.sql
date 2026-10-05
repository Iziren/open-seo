ALTER TABLE "audit_pages" ADD COLUMN "content_score" integer;--> statement-breakpoint
ALTER TABLE "audit_pages" ADD COLUMN "schema_status" text;--> statement-breakpoint
ALTER TABLE "audit_pages" ADD COLUMN "schema_types_json" text;--> statement-breakpoint
ALTER TABLE "audit_pages" ADD COLUMN "schema_findings_json" text;--> statement-breakpoint
ALTER TABLE "audit_pages" ADD COLUMN "nlp_summary_json" text;--> statement-breakpoint
ALTER TABLE "audits" ADD COLUMN "health_score" integer;--> statement-breakpoint
ALTER TABLE "audits" ADD COLUMN "score_breakdown" text;