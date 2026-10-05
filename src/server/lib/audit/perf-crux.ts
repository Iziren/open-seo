/**
 * Chrome UX Report field-data judgment (port of `crux_history.py`, plus the
 * field-vs-lab comparison and per-page verdict from `pagespeed_check.py`).
 *
 * Pure analysis over already-fetched payloads: weekly p75 timeseries
 * parsing, trend detection (first-4 vs last-4 weeks), threshold
 * classification over time, regression/improvement flags, lab-vs-field
 * agreement per metric, and a single per-page performance verdict. Live
 * fetching lives in `GooglePageSpeedService`.
 */
import {
  CWV_THRESHOLDS,
  isCwvMetricName,
  rateMetric,
  type CwvMetricName,
  type CwvRating,
  type PsiPageAnalysis,
} from "./perf-psi";

export type CruxTrendDirection =
  | "improving"
  | "stable"
  | "degrading"
  | "insufficient_data";

export interface CruxCollectionPeriod {
  first: string;
  last: string;
}

export interface CruxMetricHistory {
  label: string;
  unit: string;
  p75Values: Array<number | null>;
  goodPercentages: Array<number | null>;
  needsImprovementPercentages: Array<number | null>;
  poorPercentages: Array<number | null>;
  latestP75: number | null;
  goodThreshold: number;
  poorThreshold: number;
}

export interface CruxTrend {
  direction: CruxTrendDirection;
  changePct: number | null;
  earliestAvg: number | null;
  latestAvg: number | null;
  label: string;
  dataPoints: number;
}

export interface CruxHistoryAnalysis {
  target: string;
  formFactor: string;
  metrics: Partial<Record<CwvMetricName, CruxMetricHistory>>;
  collectionPeriods: CruxCollectionPeriod[];
  trends: Partial<Record<CwvMetricName, CruxTrend>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseP75(metricName: CwvMetricName, value: unknown): number | null {
  if (value == null) return null;
  // CLS arrives string-encoded in CrUX and stays fractional; other metrics
  // arrive numeric and mirror Python int() truncation.
  if (metricName === "cumulative_layout_shift") {
    if (typeof value !== "string" && typeof value !== "number") return null;
    const parsed = Number(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  if (typeof value !== "number") return null;
  if (Number.isNaN(value)) return null;
  return Number.isInteger(value) ? value : Math.trunc(value);
}

function parseDensities(value: unknown): Array<number | null> {
  if (!Array.isArray(value)) return [];
  return value.map((entry: unknown) => {
    // CrUX encodes missing densities as the string "NaN".
    if (entry == null || entry === "NaN") return null;
    const numeric = typeof entry === "number" ? entry : Number.NaN;
    if (Number.isNaN(numeric)) return null;
    return Math.round(numeric * 1000) / 10;
  });
}

function formatDate(part: unknown): string {
  const date = isRecord(part) ? part : {};
  const year = typeof date["year"] === "number" ? date["year"] : 0;
  const month = typeof date["month"] === "number" ? date["month"] : 0;
  const day = typeof date["day"] === "number" ? date["day"] : 0;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function lastValid(values: Array<number | null>): number | null {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index];
    if (value != null) return value;
  }
  return null;
}

function parseMetricHistory(
  metricName: CwvMetricName,
  metricData: Record<string, unknown>,
): CruxMetricHistory {
  const thresholds = CWV_THRESHOLDS[metricName];
  const timeseries = isRecord(metricData["percentilesTimeseries"])
    ? metricData["percentilesTimeseries"]
    : {};
  const rawP75s: unknown[] = Array.isArray(timeseries["p75s"])
    ? timeseries["p75s"]
    : [];
  const p75Values = rawP75s.map((value) => parseP75(metricName, value));

  const histogram: unknown[] = Array.isArray(metricData["histogramTimeseries"])
    ? metricData["histogramTimeseries"]
    : [];
  const bin = (index: number): Array<number | null> => {
    const entry: unknown = histogram[index];
    return parseDensities(isRecord(entry) ? entry["densities"] : undefined);
  };

  return {
    label: thresholds?.label ?? metricName,
    unit: thresholds?.unit ?? "",
    p75Values,
    goodPercentages: bin(0),
    needsImprovementPercentages: bin(1),
    poorPercentages: bin(2),
    latestP75: lastValid(p75Values),
    goodThreshold: thresholds?.good ?? 0,
    poorThreshold: thresholds?.poor ?? 0,
  };
}

/**
 * Port of `detect_trends`: compares the average of the last 4 valid weeks
 * to the first 4. Lower is better for every CWV metric, so a negative
 * change is an improvement. Needs >= 8 valid points.
 */
export function detectCruxTrends(
  metrics: Partial<Record<CwvMetricName, CruxMetricHistory>>,
): Partial<Record<CwvMetricName, CruxTrend>> {
  const trends: Partial<Record<CwvMetricName, CruxTrend>> = {};
  for (const [name, data] of Object.entries(metrics)) {
    if (!isCwvMetricName(name) || !data) continue;
    const valid = data.p75Values.filter(
      (value): value is number => value != null,
    );
    if (valid.length < 8) {
      trends[name] = {
        direction: "insufficient_data",
        changePct: null,
        earliestAvg: null,
        latestAvg: null,
        label: data.label,
        dataPoints: valid.length,
      };
      continue;
    }
    const first = valid.slice(0, 4);
    const last = valid.slice(-4);
    const avgFirst =
      first.reduce((sum, value) => sum + value, 0) / first.length;
    const avgLast = last.reduce((sum, value) => sum + value, 0) / last.length;
    const changePct =
      avgFirst === 0 ? 0 : ((avgLast - avgFirst) / avgFirst) * 100;
    const direction: CruxTrendDirection =
      Math.abs(changePct) < 5
        ? "stable"
        : changePct < 0
          ? "improving"
          : "degrading";
    // CLS keeps 3 decimals; millisecond metrics round to whole units.
    const round = (value: number): number =>
      data.unit === "" ? Math.round(value * 1000) / 1000 : Math.round(value);
    trends[name] = {
      direction,
      changePct: Math.round(changePct * 10) / 10,
      earliestAvg: round(avgFirst),
      latestAvg: round(avgLast),
      label: data.label,
      dataPoints: valid.length,
    };
  }
  return trends;
}

/** Port of `query_history`'s parsing half: pure, no network. */
export function parseCruxHistoryPayload(
  data: unknown,
  input: { target: string; formFactor?: string },
): CruxHistoryAnalysis {
  const record =
    isRecord(data) && isRecord(data["record"]) ? data["record"] : {};
  const periods: unknown[] = Array.isArray(record["collectionPeriods"])
    ? record["collectionPeriods"]
    : [];
  const collectionPeriods: CruxCollectionPeriod[] = [];
  for (const period of periods) {
    if (!isRecord(period)) continue;
    collectionPeriods.push({
      first: formatDate(period["firstDate"]),
      last: formatDate(period["lastDate"]),
    });
  }

  const rawMetrics = isRecord(record["metrics"]) ? record["metrics"] : {};
  const metrics: Partial<Record<CwvMetricName, CruxMetricHistory>> = {};
  for (const [name, metricData] of Object.entries(rawMetrics)) {
    if (!isCwvMetricName(name) || !isRecord(metricData)) continue;
    metrics[name] = parseMetricHistory(name, metricData);
  }
  return {
    target: input.target,
    formFactor: input.formFactor ?? "ALL",
    metrics,
    collectionPeriods,
    trends: detectCruxTrends(metrics),
  };
}

// ---- Regression / improvement summary -----------------------------------------

export type CruxHeadline =
  | "improvement"
  | "stable"
  | "regression"
  | "insufficient-data";

export interface CruxMetricSummary {
  metric: CwvMetricName;
  label: string;
  latestP75: number | null;
  latestRating: string;
  earliestRating: string | null;
  trend: CruxTrendDirection;
  changePct: number | null;
  headline: CruxHeadline;
  /** True when the rating bucket changed between first and latest week. */
  thresholdCrossed: boolean;
}

export interface CruxHistorySummary {
  target: string;
  metrics: CruxMetricSummary[];
  regressing: string[];
  improving: string[];
}

function firstValid(values: Array<number | null>): number | null {
  return values.find((value) => value != null) ?? null;
}

/**
 * Latest p75 rating per metric plus trend headlines. A threshold crossing
 * (e.g. good -> needs-improvement) is flagged even when the 4-week average
 * trend still reads stable, since bucket changes drive the CWV assessment.
 */
export function summarizeCruxHistory(
  analysis: CruxHistoryAnalysis,
): CruxHistorySummary {
  const summaries: CruxMetricSummary[] = [];
  for (const [name, history] of Object.entries(analysis.metrics)) {
    if (!isCwvMetricName(name) || !history) continue;
    const trend = analysis.trends[name];
    const latestRating =
      history.latestP75 == null
        ? "no-data"
        : rateMetric(name, history.latestP75);
    const earliest = firstValid(history.p75Values);
    const earliestRating = earliest == null ? null : rateMetric(name, earliest);
    const headline: CruxHeadline =
      !trend || trend.direction === "insufficient_data"
        ? "insufficient-data"
        : trend.direction === "improving"
          ? "improvement"
          : trend.direction === "degrading"
            ? "regression"
            : "stable";
    const thresholdCrossed =
      earliestRating != null && earliestRating !== latestRating;
    summaries.push({
      metric: name,
      label: history.label,
      latestP75: history.latestP75,
      latestRating,
      earliestRating,
      trend: trend?.direction ?? "insufficient_data",
      changePct: trend?.changePct ?? null,
      headline,
      thresholdCrossed,
    });
  }
  return {
    target: analysis.target,
    metrics: summaries,
    regressing: summaries
      .filter(
        (item) =>
          item.headline === "regression" ||
          (item.thresholdCrossed && item.latestRating === "poor"),
      )
      .map((item) => item.label),
    improving: summaries
      .filter((item) => item.headline === "improvement")
      .map((item) => item.label),
  };
}

// ---- Field-vs-lab comparison + per-page verdict ---------------------------------
// These judge PSI lab numbers against CrUX field numbers, so they live next
// to the field data rather than the PSI parser.

export type FieldLabOutcome =
  | "agree"
  | "field-worse"
  | "lab-worse"
  | "lab-only"
  | "field-only";

export interface FieldLabComparison {
  metric: CwvMetricName;
  label: string;
  labValue: number | null;
  labRating: CwvRating;
  fieldValue: number | null;
  fieldRating: string | null;
  fieldSource: string | null;
  outcome: FieldLabOutcome;
}

const LAB_TO_CWV: Record<string, CwvMetricName> = {
  "largest-contentful-paint": "largest_contentful_paint",
  "cumulative-layout-shift": "cumulative_layout_shift",
  "first-contentful-paint": "first_contentful_paint",
};

type OrderedRating = "good" | "needs-improvement" | "poor";
const RATING_ORDER: readonly OrderedRating[] = [
  "good",
  "needs-improvement",
  "poor",
];

function asOrderedRating(value: string): OrderedRating | null {
  return value === "good" || value === "needs-improvement" || value === "poor"
    ? value
    : null;
}

function compareOutcome(lab: CwvRating, field: string | null): FieldLabOutcome {
  const fieldRating = field == null ? null : asOrderedRating(field);
  const labRating = asOrderedRating(lab);
  if (fieldRating == null) return "lab-only";
  if (labRating == null) return "field-only";
  if (labRating === fieldRating) return "agree";
  return RATING_ORDER.indexOf(fieldRating) > RATING_ORDER.indexOf(labRating)
    ? "field-worse"
    : "lab-worse";
}

/** Match lab audits against p75 field data; URL-level preferred over origin. */
export function compareFieldVsLab(
  analysis: PsiPageAnalysis,
): FieldLabComparison[] {
  const out: FieldLabComparison[] = [];
  for (const [labId, metric] of Object.entries(LAB_TO_CWV)) {
    const labValue = analysis.labMetrics[labId]?.value ?? null;
    const labRating: CwvRating =
      labValue == null ? "unknown" : rateMetric(metric, labValue);
    const field =
      analysis.fieldMetrics[`url_${metric}`] ??
      analysis.fieldMetrics[`origin_${metric}`] ??
      null;
    out.push({
      metric,
      label: CWV_THRESHOLDS[metric]?.label ?? metric,
      labValue,
      labRating,
      fieldValue: field?.p75 ?? null,
      fieldRating: field?.rating ?? null,
      fieldSource: field?.source ?? null,
      outcome: compareOutcome(labRating, field?.rating ?? null),
    });
  }
  return out;
}

// ---- Per-page verdict ---------------------------------------------------------

export type PerformanceVerdict = "pass" | "needs-work" | "poor";

export interface PerformanceVerdictResult {
  verdict: PerformanceVerdict;
  reasons: string[];
}

/** Single verdict from the performance score plus the worst CWV ratings. */
export function verdictPagePerformance(
  analysis: PsiPageAnalysis,
): PerformanceVerdictResult {
  const reasons: string[] = [];
  const perfScore = analysis.lighthouseScores["performance"];
  let verdict: PerformanceVerdict = "pass";

  if (perfScore == null) {
    reasons.push("No performance score available.");
    verdict = "needs-work";
  } else if (perfScore < 50) {
    reasons.push(`Performance score ${perfScore}/100 is poor (<50).`);
    verdict = "poor";
  } else if (perfScore < 90) {
    reasons.push(`Performance score ${perfScore}/100 needs work (<90).`);
    verdict = "needs-work";
  }

  const rank: Record<PerformanceVerdict, number> = {
    pass: 0,
    "needs-work": 1,
    poor: 2,
  };
  const downgrade = (next: PerformanceVerdict, reason: string): void => {
    if (rank[next] > rank[verdict]) verdict = next;
    reasons.push(reason);
  };

  for (const row of compareFieldVsLab(analysis)) {
    const readings: Array<{
      value: number | null;
      rating: string | null;
      kind: string;
    }> = [
      { value: row.fieldValue, rating: row.fieldRating, kind: "Field" },
      { value: row.labValue, rating: row.labRating, kind: "Lab" },
    ];
    for (const reading of readings) {
      if (reading.value == null || reading.rating == null) continue;
      if (reading.rating === "poor") {
        downgrade(
          "poor",
          `${reading.kind} ${row.label} is poor (${reading.value}).`,
        );
      } else if (reading.rating === "needs-improvement") {
        downgrade(
          "needs-work",
          `${reading.kind} ${row.label} needs improvement (${reading.value}).`,
        );
      }
    }
  }

  const top = analysis.opportunities[0];
  if (top) {
    reasons.push(
      `Top opportunity: ${top.title} (save ~${Math.round(top.savingsMs)}ms).`,
    );
  }
  if (reasons.length === 0) {
    reasons.push("Performance score and Core Web Vitals are all good.");
  }
  return { verdict, reasons };
}
