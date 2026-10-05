import { describe, expect, it } from "vitest";
import {
  analyzePsiPayload,
  CWV_THRESHOLDS,
  isCwvMetricName,
  rateMetric,
  type CwvMetricName,
  type CwvRating,
  type CwvThreshold,
  type PsiAuditDetail,
  type PsiCategoryRef,
  type PsiDiagnostic,
  type PsiFailedAudit,
  type PsiFieldMetric,
  type PsiLabMetric,
  type PsiOpportunity,
  type PsiPageAnalysis,
} from "./perf-psi";

const _typeChecks: {
  metric: CwvMetricName;
  rating: CwvRating;
  threshold: CwvThreshold;
  lab: PsiLabMetric;
  field: PsiFieldMetric;
  opp: PsiOpportunity;
  diag: PsiDiagnostic;
  failed: PsiFailedAudit;
  ref: PsiCategoryRef;
  detail: PsiAuditDetail;
} = {
  metric: "largest_contentful_paint",
  rating: "good",
  threshold: CWV_THRESHOLDS["largest_contentful_paint"] ?? {
    good: 0,
    poor: 0,
    unit: "",
    label: "",
  },
  lab: { value: 1, display: "1", score: 1 },
  field: { p75: 1, rating: "good", source: "s" },
  opp: { id: "i", title: "t", savingsMs: 1, description: "d" },
  diag: { id: "i", title: "t", display: "d", score: 1, description: "x" },
  failed: { id: "i", title: "t", score: 0, display: "d", description: "x" },
  ref: { id: "i", title: "t", score: 1, pass: true },
  detail: { title: "t", headings: [], items: [], totalItems: 0 },
};
void _typeChecks;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function psiFixture(): Record<string, unknown> {
  return {
    analysisUTCTimestamp: "2026-09-01T00:00:00Z",
    lighthouseResult: {
      categories: {
        performance: { score: 0.72 },
        seo: {
          score: 0.9,
          auditRefs: [{ id: "document-title" }, { id: "meta-description" }],
        },
        accessibility: {
          score: 0.8,
          auditRefs: [{ id: "color-contrast" }, { id: "image-alt" }],
        },
        "broken-category": { score: null },
      },
      audits: {
        "largest-contentful-paint": {
          numericValue: 4200,
          displayValue: "4.2 s",
          score: 0.3,
        },
        "cumulative-layout-shift": {
          numericValue: 0.05,
          displayValue: "0.05",
          score: 0.95,
        },
        "first-contentful-paint": {
          numericValue: 1500,
          displayValue: "1.5 s",
          score: 0.95,
        },
        "total-blocking-time": {
          numericValue: 200,
          displayValue: "200 ms",
          score: 0.85,
        },
        "render-blocking-resources": {
          title: "Eliminate render-blocking resources",
          displayValue: "Potential savings of 800 ms",
          score: 0.4,
          description: "Resources block first paint.",
          details: { type: "opportunity", overallSavingsMs: 800 },
        },
        "unused-javascript": {
          title: "Reduce unused JavaScript",
          displayValue: "Potential savings of 300 ms",
          score: 0.5,
          description: "Unused JS.",
          details: { type: "opportunity", overallSavingsMs: 300 },
        },
        "dom-size": {
          title: "Avoid an excessive DOM size",
          displayValue: "1,200 elements",
          score: 0.7,
          description: "Large DOM.",
        },
        "color-contrast": {
          title: "Background and foreground colors",
          displayValue: "",
          score: 0.5,
          description: "Low contrast.",
        },
        "image-alt": {
          title: "Image elements have alt",
          displayValue: "",
          score: 1,
          description: "OK.",
        },
        "document-title": { title: "Document has a title", score: 1 },
        "meta-description": { title: "Meta description", score: 0.2 },
        "uses-responsive-images": {
          title: "Properly size images",
          displayValue: "Potential savings of 120 KiB",
          score: 0.6,
          description: "Oversized hero.",
          details: {
            headings: [{ key: "url" }, { key: "wastedBytes" }],
            items: [
              { url: "https://example.com/hero.jpg", wastedBytes: 120000 },
              { url: "https://example.com/logo.png", wastedBytes: 30000 },
            ],
          },
        },
      },
    },
    loadingExperience: {
      metrics: {
        LARGEST_CONTENTFUL_PAINT_MS: {
          percentile: 3800,
          category: "NEEDS_IMPROVEMENT",
        },
        CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: 4, category: "GOOD" },
        FIRST_CONTENTFUL_PAINT_MS: { percentile: 1600, category: "GOOD" },
      },
    },
  };
}

describe("rateMetric", () => {
  it("rates CWV boundaries", () => {
    expect(rateMetric("largest_contentful_paint", 2500)).toBe("good");
    expect(rateMetric("largest_contentful_paint", 2501)).toBe(
      "needs-improvement",
    );
    expect(rateMetric("largest_contentful_paint", 4001)).toBe("poor");
    expect(rateMetric("cumulative_layout_shift", 0.1)).toBe("good");
    expect(rateMetric("cumulative_layout_shift", 0.26)).toBe("poor");
    expect(rateMetric("nope", 1)).toBe("unknown");
    expect(rateMetric("largest_contentful_paint", Number.NaN)).toBe("unknown");
  });

  it("guards metric names", () => {
    expect(isCwvMetricName("largest_contentful_paint")).toBe(true);
    expect(isCwvMetricName("nope")).toBe(false);
  });
});

describe("analyzePsiPayload", () => {
  it("parses scores, lab, field, opportunities, and details", () => {
    const analysis: PsiPageAnalysis = analyzePsiPayload(psiFixture(), {
      url: "https://example.com/",
      strategy: "mobile",
    });
    expect(analysis.lighthouseScores["performance"]).toBe(72);
    // Null-score categories are skipped, never reported as 0.
    expect(analysis.lighthouseScores["broken-category"]).toBeUndefined();
    expect(analysis.labMetrics["largest-contentful-paint"]?.value).toBe(4200);
    expect(analysis.labMetrics["interactive"]).toBeUndefined();
    // CLS percentile 4 normalizes to a 0.04 shift score.
    expect(
      analysis.fieldMetrics["url_cumulative_layout_shift"]?.p75,
    ).toBeCloseTo(0.04);
    expect(analysis.fieldMetrics["url_largest_contentful_paint"]?.rating).toBe(
      "needs-improvement",
    );
    expect(analysis.opportunities.map((opp) => opp.id)).toEqual([
      "render-blocking-resources",
      "unused-javascript",
    ]);
    expect(analysis.diagnostics.map((diag) => diag.id)).toContain("dom-size");
    // Opportunities are excluded from failed audits.
    expect(analysis.failedAudits.map((audit) => audit.id)).not.toContain(
      "render-blocking-resources",
    );
    expect(analysis.failedAudits[0]?.score).toBeLessThanOrEqual(
      analysis.failedAudits[1]?.score ?? 1,
    );
    // Scores >= 0.9: CLS, FCP, image-alt, document-title.
    expect(analysis.passedAuditsCount).toBe(4);
    expect(analysis.seoAudits).toHaveLength(2);
    expect(analysis.accessibilityFailures.map((audit) => audit.id)).toEqual([
      "color-contrast",
    ]);
    const detail = analysis.auditDetails["uses-responsive-images"];
    expect(detail?.totalItems).toBe(2);
    expect(detail?.items[0]?.["url"]).toBe("https://example.com/hero.jpg");
    expect(analysis.analysisTimestamp).toBe("2026-09-01T00:00:00Z");
  });

  it("reads origin-level field data", () => {
    const fixture = psiFixture();
    const loading = fixture["loadingExperience"];
    if (isRecord(loading)) {
      fixture["originLoadingExperience"] = loading;
      delete fixture["loadingExperience"];
    }
    const analysis = analyzePsiPayload(fixture, {
      url: "https://example.com/",
      strategy: "mobile",
    });
    expect(
      analysis.fieldMetrics["origin_largest_contentful_paint"]?.source,
    ).toBe("PSI origin-level");
  });

  it("handles empty payloads", () => {
    const analysis = analyzePsiPayload(
      {},
      { url: "https://example.com/", strategy: "mobile" },
    );
    expect(analysis.opportunities).toEqual([]);
    expect(analysis.passedAuditsCount).toBe(0);
    expect(analysis.analysisTimestamp).toBeNull();
  });
});
