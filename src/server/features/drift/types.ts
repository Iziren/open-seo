// Shared drift types: the captured attribute shape, the diff shape, and the
// closed vocabularies written to seo_drift_changes.

export type DriftChangeType = "added" | "removed" | "changed";

export type DriftSeverity = "critical" | "warning" | "info";

/** snake_case identifiers written to seo_drift_changes.field. */
export type DriftField =
  | "status_code"
  | "indexable"
  | "title"
  | "meta_description"
  | "canonical_url"
  | "h1"
  | "robots_meta"
  | "schema_json_ld"
  | "word_count"
  | "external_link_count"
  | "headers";

/**
 * SEO attributes captured for one URL — the row shape of seo_drift_snapshots
 * without identity/timestamp columns, so stored rows and freshly captured
 * state share one diffable type.
 */
export type DriftAttributes = {
  url: string;
  canonicalUrl: string | null;
  title: string | null;
  metaDescription: string | null;
  h1: string | null;
  schemaJsonLd: string | null;
  robotsMeta: string | null;
  statusCode: number | null;
  indexable: boolean;
  wordCount: number;
  externalLinkCount: number;
  headersJson: string | null;
};

/** One field-level difference between baseline and current state. */
export type DriftDiff = {
  url: string;
  field: DriftField;
  oldValue: string | null;
  newValue: string | null;
  changeType: DriftChangeType;
  severity: DriftSeverity;
};

/** An unresolved seo_drift_changes row, as read for reconciliation. */
export type DriftOpenChange = {
  id: string;
  url: string;
  field: string;
  oldValue: string | null;
  newValue: string | null;
  changeType: DriftChangeType;
};
