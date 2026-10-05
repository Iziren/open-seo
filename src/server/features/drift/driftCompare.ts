import {
  canonicalizeJson,
  collapseWhitespace,
  normalizeCanonicalUrl,
  similarityRatio,
  textEqualsIgnoringTruncation,
} from "./driftNormalize";
import type {
  DriftAttributes,
  DriftDiff,
  DriftField,
  DriftOpenChange,
  DriftSeverity,
} from "./types";

// Google retired these rich-result types (port of drift_compare.py rule 1):
// removing them downgrades from critical to warning, because losing them is
// not a Google Search rich-result loss.
const RETIRED_SCHEMA_TYPES = new Set(["FAQPage", "HowTo", "Dataset"]);
// Titles render ~60 chars and meta descriptions ~160 in the SERP; a capture
// differing only past those lengths is display truncation, not drift.
const TITLE_TRUNCATION_CHARS = 60;
const META_TRUNCATION_CHARS = 160;
// H1 similarity below this means a different heading, not an edit (rule 6).
const H1_MIN_SIMILARITY = 0.5;

type TextSeverities = {
  added: DriftSeverity;
  removed: DriftSeverity;
  changed: DriftSeverity;
};

type TextInput = {
  url: string;
  field: DriftField;
  before: string | null;
  after: string | null;
  severities: TextSeverities;
  truncationChars?: number;
  severityWhenChanged?: (before: string, after: string) => DriftSeverity;
};

/**
 * Field-level diff between a stored baseline snapshot and the current state
 * of the same URL. Pure: no I/O, no clock — the same pair of inputs always
 * yields the same diffs, which is what makes reconciliation idempotent.
 */
export function diffSnapshots(
  baseline: DriftAttributes,
  current: DriftAttributes,
): DriftDiff[] {
  const found = [
    diffStatusCode(baseline, current),
    diffIndexable(baseline, current),
    diffTitle(baseline, current),
    diffMetaDescription(baseline, current),
    diffCanonicalUrl(baseline, current),
    diffH1(baseline, current),
    diffRobotsMeta(baseline, current),
    diffSchemaJsonLd(baseline, current),
    diffCount("word_count", baseline.wordCount, current.wordCount, current.url),
    diffCount(
      "external_link_count",
      baseline.externalLinkCount,
      current.externalLinkCount,
      current.url,
    ),
    diffHeaders(baseline, current),
  ];
  return found.filter((diff): diff is DriftDiff => diff !== null);
}

/**
 * Diff plan for one compare run: which changes to insert, which open rows to
 * retire, and which to leave untouched.
 *
 * - A diff identical to an already-open row stays open (keeps first-seen
 *   detected_at).
 * - A diff whose values differ from the open row retires it and re-inserts,
 *   so history shows each distinct state once.
 * - An open row with no current diff means the field is back at baseline →
 *   resolved. Open rows for URLs that could not be fetched are left alone:
 *   unknown state must never read as "fixed".
 */
export function reconcileChanges(input: {
  openChanges: DriftOpenChange[];
  diffs: DriftDiff[];
  comparedUrls: ReadonlySet<string>;
}): {
  inserts: DriftDiff[];
  resolveIds: string[];
  keptIds: string[];
} {
  const diffByKey = new Map<string, DriftDiff>();
  for (const diff of input.diffs) {
    diffByKey.set(changeKey(diff.url, diff.field), diff);
  }
  const openByKey = new Map<string, DriftOpenChange>();
  for (const open of input.openChanges) {
    openByKey.set(changeKey(open.url, open.field), open);
  }

  const inserts: DriftDiff[] = [];
  const resolveIds: string[] = [];
  const keptIds: string[] = [];

  for (const diff of input.diffs) {
    const open = openByKey.get(changeKey(diff.url, diff.field));
    if (!open) {
      inserts.push(diff);
      continue;
    }
    const unchanged =
      open.oldValue === diff.oldValue &&
      open.newValue === diff.newValue &&
      open.changeType === diff.changeType;
    if (unchanged) {
      keptIds.push(open.id);
      continue;
    }
    resolveIds.push(open.id);
    inserts.push(diff);
  }

  for (const open of input.openChanges) {
    if (!input.comparedUrls.has(open.url)) continue;
    if (diffByKey.has(changeKey(open.url, open.field))) continue;
    resolveIds.push(open.id);
  }

  return { inserts, resolveIds, keptIds };
}

function changeKey(url: string, field: string): string {
  return `${url}\u0000${field}`;
}

// ---------------------------------------------------------------------------
// Field rules
// ---------------------------------------------------------------------------

function diffStatusCode(
  baseline: DriftAttributes,
  current: DriftAttributes,
): DriftDiff | null {
  const before = baseline.statusCode;
  const after = current.statusCode;
  if (before == null || after == null) return null;
  if (Math.floor(before / 100) === Math.floor(after / 100)) return null;
  return {
    url: current.url,
    field: "status_code",
    oldValue: String(before),
    newValue: String(after),
    changeType: "changed",
    // A serving page falling into 4xx/5xx is the severe case (rankings drop
    // within days); every other class change (e.g. 404 fixed to 200) is still
    // a real change worth review, at warning level.
    severity: before < 400 && after >= 400 ? "critical" : "warning",
  };
}

function diffIndexable(
  baseline: DriftAttributes,
  current: DriftAttributes,
): DriftDiff | null {
  if (baseline.indexable === current.indexable) return null;
  return {
    url: current.url,
    field: "indexable",
    oldValue: String(baseline.indexable),
    newValue: String(current.indexable),
    changeType: "changed",
    // Losing indexability drops the page from search results; regaining it
    // is a fix, not a regression.
    severity: baseline.indexable ? "critical" : "info",
  };
}

function diffTitle(
  baseline: DriftAttributes,
  current: DriftAttributes,
): DriftDiff | null {
  return diffText({
    url: current.url,
    field: "title",
    before: baseline.title,
    after: current.title,
    severities: { added: "info", removed: "critical", changed: "warning" },
    truncationChars: TITLE_TRUNCATION_CHARS,
  });
}

function diffMetaDescription(
  baseline: DriftAttributes,
  current: DriftAttributes,
): DriftDiff | null {
  return diffText({
    url: current.url,
    field: "meta_description",
    before: baseline.metaDescription,
    after: current.metaDescription,
    severities: { added: "info", removed: "warning", changed: "warning" },
    truncationChars: META_TRUNCATION_CHARS,
  });
}

function diffRobotsMeta(
  baseline: DriftAttributes,
  current: DriftAttributes,
): DriftDiff | null {
  // noindex additions also flip `indexable`, which carries the critical
  // severity; robots text changes without an indexability flip stay here.
  return diffText({
    url: current.url,
    field: "robots_meta",
    before: baseline.robotsMeta,
    after: current.robotsMeta,
    severities: { added: "warning", removed: "warning", changed: "warning" },
  });
}

function diffH1(
  baseline: DriftAttributes,
  current: DriftAttributes,
): DriftDiff | null {
  return diffText({
    url: current.url,
    field: "h1",
    before: baseline.h1,
    after: current.h1,
    severities: { added: "info", removed: "critical", changed: "warning" },
    severityWhenChanged: (before, after) =>
      similarityRatio(before, after) < H1_MIN_SIMILARITY
        ? "critical"
        : "warning",
  });
}

function diffCanonicalUrl(
  baseline: DriftAttributes,
  current: DriftAttributes,
): DriftDiff | null {
  const before = baseline.canonicalUrl?.trim() || null;
  const after = current.canonicalUrl?.trim() || null;
  if (before === after) return null;
  if (before === null || after === null) {
    const added = before === null;
    return {
      url: current.url,
      field: "canonical_url",
      oldValue: before,
      newValue: after,
      changeType: added ? "added" : "removed",
      // Removing a canonical lets Google guess it (often wrongly); adding one
      // is usually deliberate but must point at the right page — verify.
      severity: added ? "warning" : "critical",
    };
  }
  // Trailing slash / http→https / www / default port / query order are the
  // same canonical target; only a genuinely different target is drift.
  if (normalizeCanonicalUrl(before) === normalizeCanonicalUrl(after))
    return null;
  return {
    url: current.url,
    field: "canonical_url",
    oldValue: before,
    newValue: after,
    changeType: "changed",
    severity: "critical",
  };
}

function diffSchemaJsonLd(
  baseline: DriftAttributes,
  current: DriftAttributes,
): DriftDiff | null {
  const beforeBlocks = parseSchemaBlocks(baseline.schemaJsonLd);
  const afterBlocks = parseSchemaBlocks(current.schemaJsonLd);
  const before =
    beforeBlocks.length > 0 ? canonicalizeJson(beforeBlocks) : null;
  const after = afterBlocks.length > 0 ? canonicalizeJson(afterBlocks) : null;
  if (before === after) return null;

  if (before === null) {
    return {
      url: current.url,
      field: "schema_json_ld",
      oldValue: null,
      newValue: after,
      changeType: "added",
      severity: "info",
    };
  }
  if (after === null) {
    const types = schemaTypes(beforeBlocks);
    const retiredOnly =
      types.length > 0 && types.every((type) => RETIRED_SCHEMA_TYPES.has(type));
    return {
      url: current.url,
      field: "schema_json_ld",
      oldValue: before,
      newValue: null,
      changeType: "removed",
      severity: retiredOnly ? "warning" : "critical",
    };
  }
  return {
    url: current.url,
    field: "schema_json_ld",
    oldValue: before,
    newValue: after,
    changeType: "changed",
    severity: "warning",
  };
}

function diffCount(
  field: DriftField,
  before: number,
  after: number,
  url: string,
): DriftDiff | null {
  if (before === after) return null;
  return {
    url,
    field,
    oldValue: String(before),
    newValue: String(after),
    changeType: "changed",
    // The content-changed catch-all (rule 17's role): nearly every real edit
    // moves a count, so these surface "the page changed" at info level.
    severity: "info",
  };
}

function diffHeaders(
  baseline: DriftAttributes,
  current: DriftAttributes,
): DriftDiff | null {
  const before = canonicalizeHeaders(baseline.headersJson);
  const after = canonicalizeHeaders(current.headersJson);
  if (before === after) return null;
  return {
    url: current.url,
    field: "headers",
    oldValue: before,
    newValue: after,
    changeType: "changed",
    severity: "info",
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function diffText(input: TextInput): DriftDiff | null {
  const before = normalizeText(input.before);
  const after = normalizeText(input.after);
  if (before === after) return null;

  if (before === null || after === null) {
    const added = before === null;
    return {
      url: input.url,
      field: input.field,
      oldValue: before,
      newValue: after,
      changeType: added ? "added" : "removed",
      severity: added ? input.severities.added : input.severities.removed,
    };
  }

  if (
    input.truncationChars !== undefined &&
    textEqualsIgnoringTruncation(before, after, input.truncationChars)
  ) {
    return null;
  }

  return {
    url: input.url,
    field: input.field,
    oldValue: before,
    newValue: after,
    changeType: "changed",
    severity: input.severityWhenChanged
      ? input.severityWhenChanged(before, after)
      : input.severities.changed,
  };
}

function normalizeText(value: string | null): string | null {
  if (value === null) return null;
  const collapsed = collapseWhitespace(value);
  return collapsed || null;
}

/** Capture only ever writes a JSON array; anything else counts as absent. */
function parseSchemaBlocks(raw: string | null): unknown[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return [];
  }
  const blocks: unknown[] = [];
  if (Array.isArray(parsed)) {
    for (const block of parsed) blocks.push(block);
  }
  return blocks;
}

function schemaTypes(blocks: unknown[]): string[] {
  const types = new Set<string>();
  for (const block of blocks) collectSchemaTypes(block, types);
  return [...types];
}

function collectSchemaTypes(block: unknown, types: Set<string>): void {
  if (!isRecord(block)) return;
  const rawType = block["@type"];
  if (typeof rawType === "string") {
    if (rawType) types.add(stripTypeSuffix(rawType));
    return;
  }
  if (Array.isArray(rawType)) {
    for (const item of rawType) {
      if (typeof item === "string" && item) types.add(stripTypeSuffix(item));
    }
  }
}

/** "https://schema.org/Article" / "Article#Section" → "Article" / "Section". */
function stripTypeSuffix(value: string): string {
  const afterSlash = value.slice(value.lastIndexOf("/") + 1);
  return afterSlash.slice(afterSlash.lastIndexOf("#") + 1);
}

function canonicalizeHeaders(raw: string | null): string {
  if (!raw) return "{}";
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
    ) {
      return canonicalizeJson(parsed);
    }
  } catch {
    // Opaque/unparsable header text still compares as raw text below.
  }
  return raw;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
