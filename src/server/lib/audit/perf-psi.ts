/**
 * PageSpeed Insights payload parsing (port of `pagespeed_check.py`).
 *
 * Pure interpretation of an already-fetched PSI response: Lighthouse scores,
 * lab metrics, CrUX field metrics, opportunities, diagnostics, failed-audit
 * triage, and per-resource audit details. No network; live fetching lives in
 * `GooglePageSpeedService` under `features/lighthouse/services`.
 *
 * Field-vs-lab judgment and the per-page verdict live in `perf-crux.ts`,
 * next to the field data they reason about.
 */

export interface CwvThreshold {
  readonly good: number;
  readonly poor: number;
  readonly unit: string;
  readonly label: string;
}

// Core Web Vitals thresholds, March 2026 per the Python source. Typed as a
// string-keyed record so helpers can look up arbitrary metric names without
// assertions; the union below keeps known keys precise for callers.
export const CWV_THRESHOLDS: Record<string, CwvThreshold> = {
  largest_contentful_paint: {
    good: 2500,
    poor: 4000,
    unit: "ms",
    label: "LCP",
  },
  interaction_to_next_paint: { good: 200, poor: 500, unit: "ms", label: "INP" },
  cumulative_layout_shift: { good: 0.1, poor: 0.25, unit: "", label: "CLS" },
  first_contentful_paint: { good: 1800, poor: 3000, unit: "ms", label: "FCP" },
  experimental_time_to_first_byte: {
    good: 800,
    poor: 1800,
    unit: "ms",
    label: "TTFB",
  },
};

export type CwvMetricName =
  | "largest_contentful_paint"
  | "interaction_to_next_paint"
  | "cumulative_layout_shift"
  | "first_contentful_paint"
  | "experimental_time_to_first_byte";

export type CwvRating = "good" | "needs-improvement" | "poor" | "unknown";

export function isCwvMetricName(name: string): name is CwvMetricName {
  return name in CWV_THRESHOLDS;
}

/** Port of `rate_metric`: lower is better for every CWV metric. */
export function rateMetric(metricName: string, value: number): CwvRating {
  const thresholds = CWV_THRESHOLDS[metricName];
  if (!thresholds || Number.isNaN(value)) return "unknown";
  if (value <= thresholds.good) return "good";
  if (value <= thresholds.poor) return "needs-improvement";
  return "poor";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && !Number.isNaN(value) ? value : null;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

// ---- PSI payload analysis -------------------------------------------------

export interface PsiLabMetric {
  value: number;
  display: string;
  score: number | null;
}

export interface PsiFieldMetric {
  p75: number;
  rating: string;
  source: string;
}

export interface PsiOpportunity {
  id: string;
  title: string;
  savingsMs: number;
  description: string;
}

export interface PsiDiagnostic {
  id: string;
  title: string;
  display: string;
  score: number | null;
  description: string;
}

export interface PsiFailedAudit {
  id: string;
  title: string;
  score: number;
  display: string;
  description: string;
}

export interface PsiCategoryRef {
  id: string;
  title: string;
  score: number;
  pass: boolean;
}

export interface PsiAuditDetail {
  title: string;
  headings: string[];
  items: Array<Record<string, unknown>>;
  totalItems: number;
}

export interface PsiPageAnalysis {
  url: string;
  strategy: string;
  lighthouseScores: Record<string, number>;
  labMetrics: Record<string, PsiLabMetric>;
  fieldMetrics: Record<string, PsiFieldMetric>;
  opportunities: PsiOpportunity[];
  diagnostics: PsiDiagnostic[];
  failedAudits: PsiFailedAudit[];
  passedAuditsCount: number;
  seoAudits: PsiCategoryRef[];
  accessibilityFailures: PsiCategoryRef[];
  auditDetails: Record<string, PsiAuditDetail>;
  analysisTimestamp: string | null;
}

// PSI loadingExperience keys mapped to CrUX metric names, per the Python map.
const PSI_METRIC_MAP: Record<string, CwvMetricName> = {
  LARGEST_CONTENTFUL_PAINT_MS: "largest_contentful_paint",
  INTERACTION_TO_NEXT_PAINT: "interaction_to_next_paint",
  CUMULATIVE_LAYOUT_SHIFT_SCORE: "cumulative_layout_shift",
  FIRST_CONTENTFUL_PAINT_MS: "first_contentful_paint",
  EXPERIMENTAL_TIME_TO_FIRST_BYTE: "experimental_time_to_first_byte",
};

const LAB_AUDIT_IDS =
  "first-contentful-paint|largest-contentful-paint|total-blocking-time|cumulative-layout-shift|speed-index|interactive".split(
    "|",
  );

// Fixed diagnostic allowlist from run_pagespeed: these explain bottlenecks
// even when they carry no savings estimate.
const DIAGNOSTIC_IDS =
  "dom-size|render-blocking-resources|uses-long-cache-ttl|total-byte-weight|mainthread-work-breakdown|bootup-time|font-display|third-party-summary|largest-contentful-paint-element|layout-shifts|long-tasks|duplicated-javascript|legacy-javascript|unused-javascript|unused-css-rules".split(
    "|",
  );

/** Accept either a raw Lighthouse result or a PSI v5 response envelope. */
function lighthouseRoot(data: unknown): Record<string, unknown> | undefined {
  if (!isRecord(data)) return undefined;
  const nested = data["lighthouseResult"];
  if (isRecord(nested)) return nested;
  return data;
}

function readLhrMap(
  data: unknown,
  key: string,
): Record<string, Record<string, unknown>> {
  const root = lighthouseRoot(data);
  const section = root?.[key];
  if (!isRecord(section)) return {};
  const out: Record<string, Record<string, unknown>> = {};
  for (const [entryKey, value] of Object.entries(section)) {
    if (isRecord(value)) out[entryKey] = value;
  }
  return out;
}

function collectLabMetrics(
  audits: Record<string, Record<string, unknown>>,
): Record<string, PsiLabMetric> {
  const lab: Record<string, PsiLabMetric> = {};
  for (const auditId of LAB_AUDIT_IDS) {
    const audit = audits[auditId];
    const value = audit ? asNumber(audit["numericValue"]) : null;
    if (value != null) {
      lab[auditId] = {
        value,
        display: asString(audit["displayValue"]),
        score: asNumber(audit["score"]),
      };
    }
  }
  return lab;
}

function collectFieldMetrics(data: unknown): Record<string, PsiFieldMetric> {
  const field: Record<string, PsiFieldMetric> = {};
  if (!isRecord(data)) return field;
  for (const [expKey, level] of [
    ["loadingExperience", "url"],
    ["originLoadingExperience", "origin"],
  ]) {
    const exp = data[expKey];
    if (!isRecord(exp) || !isRecord(exp["metrics"])) continue;
    const metrics = exp["metrics"];
    for (const [psiName, cruxName] of Object.entries(PSI_METRIC_MAP)) {
      const metric = metrics[psiName];
      if (!isRecord(metric)) continue;
      const rawP75 = asNumber(metric["percentile"]);
      if (rawP75 == null) continue;
      // PSI reports CLS scaled by 100; normalize back to a 0-1 shift score.
      const p75 =
        cruxName === "cumulative_layout_shift" && rawP75 > 1
          ? rawP75 / 100
          : rawP75;
      field[`${level}_${cruxName}`] = {
        p75,
        rating: asString(metric["category"], "none")
          .toLowerCase()
          .replace(/_/g, "-"),
        source: `PSI ${level}-level`,
      };
    }
  }
  return field;
}

function collectOpportunities(
  audits: Record<string, Record<string, unknown>>,
): PsiOpportunity[] {
  const opportunities: PsiOpportunity[] = [];
  for (const [auditId, audit] of Object.entries(audits)) {
    const details = audit["details"];
    if (!isRecord(details) || details["type"] !== "opportunity") continue;
    const savings = asNumber(details["overallSavingsMs"]);
    if (savings != null && savings > 0) {
      opportunities.push({
        id: auditId,
        title: asString(audit["title"], auditId),
        savingsMs: savings,
        description: asString(audit["description"]),
      });
    }
  }
  opportunities.sort((a, b) => b.savingsMs - a.savingsMs);
  return opportunities;
}

function collectDiagnostics(
  audits: Record<string, Record<string, unknown>>,
): PsiDiagnostic[] {
  const diagnostics: PsiDiagnostic[] = [];
  for (const diagId of DIAGNOSTIC_IDS) {
    const audit = audits[diagId];
    if (!audit) continue;
    diagnostics.push({
      id: diagId,
      title: asString(audit["title"], diagId),
      display: asString(audit["displayValue"]),
      score: asNumber(audit["score"]),
      description: asString(audit["description"]),
    });
  }
  return diagnostics;
}

function collectPassFail(
  audits: Record<string, Record<string, unknown>>,
  skip: Set<string>,
): { failed: PsiFailedAudit[]; passed: number } {
  const failed: PsiFailedAudit[] = [];
  let passed = 0;
  for (const [auditId, audit] of Object.entries(audits)) {
    const score = asNumber(audit["score"]);
    if (score == null) continue;
    if (score >= 0.9) {
      passed += 1;
      continue;
    }
    if (skip.has(auditId)) continue;
    failed.push({
      id: auditId,
      title: asString(audit["title"], auditId),
      score,
      display: asString(audit["displayValue"]),
      description: asString(audit["description"]),
    });
  }
  failed.sort((a, b) => a.score - b.score);
  return { failed, passed };
}

function collectCategoryRefs(
  categories: Record<string, Record<string, unknown>>,
  audits: Record<string, Record<string, unknown>>,
  categoryId: string,
  onlyFailing: boolean,
): PsiCategoryRef[] {
  const category = categories[categoryId];
  const refs = category?.["auditRefs"];
  if (!Array.isArray(refs)) return [];
  const out: PsiCategoryRef[] = [];
  for (const ref of refs) {
    if (!isRecord(ref) || typeof ref["id"] !== "string") continue;
    const audit = audits[ref["id"]];
    const score = audit ? asNumber(audit["score"]) : null;
    if (score == null || (onlyFailing && score >= 0.9)) continue;
    out.push({
      id: ref["id"],
      title: asString(audit["title"], ref["id"]),
      score,
      pass: score >= 0.9,
    });
  }
  return out;
}

function compactDetailValue(value: unknown): unknown {
  if (isRecord(value)) {
    const nested = value["url"] ?? value["text"];
    if (typeof nested === "string") return nested;
    return asString(value["value"], JSON.stringify(value).slice(0, 200));
  }
  return value;
}

function collectAuditDetails(
  audits: Record<string, Record<string, unknown>>,
): Record<string, PsiAuditDetail> {
  // Captures WHICH resources are problems (e.g. "hero.jpg is 2MB"), not just
  // that an audit failed. Capped at 5 rows per audit like the Python port.
  const details: Record<string, PsiAuditDetail> = {};
  for (const [auditId, audit] of Object.entries(audits)) {
    const auditDetails = audit["details"];
    if (!isRecord(auditDetails)) continue;
    const { items, headings } = auditDetails;
    if (!Array.isArray(items) || !Array.isArray(headings)) continue;
    const headingKeys = headings
      .filter(isRecord)
      .map((heading) => heading["key"])
      .filter((key): key is string => typeof key === "string" && key !== "");
    if (headingKeys.length === 0) continue;
    const rows: Array<Record<string, unknown>> = [];
    for (const item of items.slice(0, 5)) {
      if (!isRecord(item)) continue;
      const row: Record<string, unknown> = {};
      for (const key of headingKeys) {
        if (item[key] != null) row[key] = compactDetailValue(item[key]);
      }
      if (Object.keys(row).length > 0) rows.push(row);
    }
    if (rows.length > 0) {
      details[auditId] = {
        title: asString(audit["title"], auditId),
        headings: headingKeys,
        items: rows,
        totalItems: items.length,
      };
    }
  }
  return details;
}

/** Port of `run_pagespeed`'s parsing half: pure, no network. */
export function analyzePsiPayload(
  data: unknown,
  input: { url: string; strategy: string },
): PsiPageAnalysis {
  const audits = readLhrMap(data, "audits");
  const categories = readLhrMap(data, "categories");
  const opportunities = collectOpportunities(audits);
  const { failed, passed } = collectPassFail(
    audits,
    new Set(opportunities.map((opp) => opp.id)),
  );
  const lighthouseScores: Record<string, number> = {};
  for (const [catKey, catData] of Object.entries(categories)) {
    // Lighthouse emits score null when it could not evaluate a category;
    // skipping avoids reporting a misleading 0/100.
    const score = asNumber(catData["score"]);
    if (score != null) lighthouseScores[catKey] = Math.round(score * 100);
  }
  // analysisUTCTimestamp lives on the PSI envelope, not inside the LHR.
  const envelope = isRecord(data) ? data["analysisUTCTimestamp"] : undefined;
  return {
    url: input.url,
    strategy: input.strategy,
    lighthouseScores,
    labMetrics: collectLabMetrics(audits),
    fieldMetrics: collectFieldMetrics(data),
    opportunities,
    diagnostics: collectDiagnostics(audits),
    failedAudits: failed,
    passedAuditsCount: passed,
    seoAudits: collectCategoryRefs(categories, audits, "seo", false),
    accessibilityFailures: collectCategoryRefs(
      categories,
      audits,
      "accessibility",
      true,
    ),
    auditDetails: collectAuditDetails(audits),
    analysisTimestamp: typeof envelope === "string" ? envelope : null,
  };
}
