import { sql } from "drizzle-orm";
import { boolean, index, integer, pgTable, text } from "drizzle-orm/pg-core";
import { projects } from "./app.schema";

// ============================================================================
// SEO drift monitoring tables (baseline → snapshot → detected changes)
// ============================================================================

// Timestamps are stored as *text* (same column shape as the SQLite schema);
// see the note in pg/app.schema.ts. `isoNow` matches `new Date().toISOString()`
// so DB-defaulted and app-written values sort together lexicographically.
const isoNow = sql`to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const timestampColumn = (name: string) => text(name).notNull().default(isoNow);

// One row per baseline capture: a named set of URL snapshots the project
// later compares against.
export const seoDriftBaselines = pgTable(
  "seo_drift_baselines",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: timestampColumn("created_at"),
    // Null until the first comparison runs; the weekly cron treats
    // never-compared baselines as due.
    lastComparedAt: text("last_compared_at"),
  },
  (table) => [index("seo_drift_baselines_project_id_idx").on(table.projectId)],
);

// One row per URL captured into a baseline: the SEO attributes compared on
// every later run. Immutable — the baseline is the "known good" reference.
export const seoDriftSnapshots = pgTable(
  "seo_drift_snapshots",
  {
    id: text("id").primaryKey(),
    baselineId: text("baseline_id")
      .notNull()
      .references(() => seoDriftBaselines.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    canonicalUrl: text("canonical_url"),
    title: text("title"),
    metaDescription: text("meta_description"),
    h1: text("h1"),
    // JSON array of parsed application/ld+json blocks, stored as text (not
    // jsonb) so the column is byte-identical across dialects.
    schemaJsonLd: text("schema_json_ld"),
    robotsMeta: text("robots_meta"),
    statusCode: integer("status_code"),
    indexable: boolean("indexable").notNull().default(true),
    wordCount: integer("word_count").notNull().default(0),
    externalLinkCount: integer("external_link_count").notNull().default(0),
    // JSON object of response headers of interest (x-robots-tag, link, ...).
    headersJson: text("headers_json"),
    capturedAt: timestampColumn("captured_at"),
  },
  (table) => [
    index("seo_drift_snapshots_baseline_url_idx").on(
      table.baselineId,
      table.url,
    ),
    index("seo_drift_snapshots_url_idx").on(table.url),
  ],
);

// One row per detected field-level difference between a baseline snapshot and
// a later capture of the same URL. `resolved_at` is set when a later compare
// finds the field back at its baseline value.
export const seoDriftChanges = pgTable(
  "seo_drift_changes",
  {
    id: text("id").primaryKey(),
    baselineId: text("baseline_id")
      .notNull()
      .references(() => seoDriftBaselines.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    // DriftField identifier (snake_case), e.g. "canonical_url".
    field: text("field").notNull(),
    oldValue: text("old_value"),
    newValue: text("new_value"),
    changeType: text("change_type", {
      enum: ["added", "removed", "changed"],
    }).notNull(),
    severity: text("severity", {
      enum: ["critical", "warning", "info"],
    }).notNull(),
    detectedAt: timestampColumn("detected_at"),
    resolvedAt: text("resolved_at"),
  },
  (table) => [
    index("seo_drift_changes_baseline_id_idx").on(table.baselineId),
    index("seo_drift_changes_url_idx").on(table.url),
  ],
);
