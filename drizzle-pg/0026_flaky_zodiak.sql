CREATE TABLE "seo_drift_baselines" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "seo_drift_changes" (
	"id" text PRIMARY KEY NOT NULL,
	"baseline_id" text NOT NULL,
	"url" text NOT NULL,
	"field" text NOT NULL,
	"old_value" text,
	"new_value" text,
	"change_type" text NOT NULL,
	"severity" text NOT NULL,
	"detected_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"resolved_at" text
);
--> statement-breakpoint
CREATE TABLE "seo_drift_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"baseline_id" text NOT NULL,
	"url" text NOT NULL,
	"canonical_url" text,
	"title" text,
	"meta_description" text,
	"h1" text,
	"schema_json_ld" text,
	"robots_meta" text,
	"status_code" integer,
	"indexable" boolean DEFAULT true NOT NULL,
	"word_count" integer DEFAULT 0 NOT NULL,
	"external_link_count" integer DEFAULT 0 NOT NULL,
	"headers_json" text,
	"captured_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "seo_drift_baselines" ADD CONSTRAINT "seo_drift_baselines_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seo_drift_changes" ADD CONSTRAINT "seo_drift_changes_baseline_id_seo_drift_baselines_id_fk" FOREIGN KEY ("baseline_id") REFERENCES "public"."seo_drift_baselines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seo_drift_snapshots" ADD CONSTRAINT "seo_drift_snapshots_baseline_id_seo_drift_baselines_id_fk" FOREIGN KEY ("baseline_id") REFERENCES "public"."seo_drift_baselines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "seo_drift_baselines_project_id_idx" ON "seo_drift_baselines" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "seo_drift_changes_baseline_id_idx" ON "seo_drift_changes" USING btree ("baseline_id");--> statement-breakpoint
CREATE INDEX "seo_drift_changes_url_idx" ON "seo_drift_changes" USING btree ("url");--> statement-breakpoint
CREATE INDEX "seo_drift_snapshots_baseline_url_idx" ON "seo_drift_snapshots" USING btree ("baseline_id","url");--> statement-breakpoint
CREATE INDEX "seo_drift_snapshots_url_idx" ON "seo_drift_snapshots" USING btree ("url");