import { describe, expect, it } from "vitest";
import { analyzePsiPayload, type PsiPageAnalysis } from "./perf-psi";
import {
  compareFieldVsLab,
  detectCruxTrends,
  parseCruxHistoryPayload,
  summarizeCruxHistory,
  verdictPagePerformance,
  type CruxCollectionPeriod,
  type CruxHeadline,
  type CruxHistoryAnalysis,
  type CruxHistorySummary,
  type CruxMetricHistory,
  type CruxMetricSummary,
  type CruxTrend,
  type CruxTrendDirection,
  type FieldLabComparison,
  type FieldLabOutcome,
  type PerformanceVerdict,
  type PerformanceVerdictResult,
} from "./perf-crux";

const _typeChecks: {
  period: CruxCollectionPeriod;
  trend: CruxTrend;
  direction: CruxTrendDirection;
  headline: CruxHeadline;
  outcome: FieldLabOutcome;
  verdict: PerformanceVerdict;
} = {
  period: { first: "2026-01-01", last: "2026-01-28" },
  trend: {
    direction: "stable",
    changePct: 0,
    earliestAvg: 1,
    latestAvg: 1,
    label: "LCP",
    dataPoints: 8,
  },
  direction: "stable",
  headline: "stable",
  outcome: "agree",
  verdict: "pass",
};
void _typeChecks;

function historyFixture(
  p75s: Array<number | string | null>,
): Record<string, unknown> {
  const densities = p75s.map(() => 0.7);
  return {
    record: {
      collectionPeriods: [
        {
          firstDate: { year: 2026, month: 1, day: 1 },
          lastDate: { year: 2026, month: 1, day: 28 },
        },
        {
          firstDate: { year: 2026, month: 2, day: 1 },
          lastDate: { year: 2026, month: 2, day: 28 },
        },
      ],
      metrics: {
        largest_contentful_paint: {
          percentilesTimeseries: { p75s },
          histogramTimeseries: [
            { densities },
            { densities: densities.map(() => 0.2) },
            { densities: densities.map(() => 0.1) },
          ],
        },
        // Unknown metrics are skipped, matching the Python port.
        some_future_metric: { percentilesTimeseries: { p75s: [1] } },
      },
    },
  };
}

function cruxHistory(
  p75s: Array<number | null>,
  unit = "ms",
): CruxMetricHistory {
  return {
    label: "LCP",
    unit,
    p75Values: p75s,
    goodPercentages: [],
    needsImprovementPercentages: [],
    poorPercentages: [],
    latestP75: null,
    goodThreshold: 2500,
    poorThreshold: 4000,
  };
}

function psiFixture(input: {
  perfScore: number | null;
  lcpLab: number;
  lcpField: number;
  lcpFieldRating: string;
}): Record<string, unknown> {
  return {
    lighthouseResult: {
      categories: {
        performance: input.perfScore == null ? {} : { score: input.perfScore },
      },
      audits: {
        "largest-contentful-paint": {
          numericValue: input.lcpLab,
          displayValue: `${input.lcpLab} ms`,
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
        "render-blocking-resources": {
          title: "Eliminate render-blocking resources",
          score: 0.4,
          description: "Blocks paint.",
          details: { type: "opportunity", overallSavingsMs: 800 },
        },
      },
    },
    loadingExperience: {
      metrics: {
        LARGEST_CONTENTFUL_PAINT_MS: {
          percentile: input.lcpField,
          category: input.lcpFieldRating,
        },
        CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: 4, category: "GOOD" },
        FIRST_CONTENTFUL_PAINT_MS: { percentile: 1600, category: "GOOD" },
      },
    },
  };
}

describe("parseCruxHistoryPayload", () => {
  it("parses timeseries and distributions", () => {
    const analysis: CruxHistoryAnalysis = parseCruxHistoryPayload(
      historyFixture([3000, 3100, 3200, 3300, 3400, 3500, 3600, 3700]),
      { target: "https://example.com/", formFactor: "PHONE" },
    );
    expect(analysis.target).toBe("https://example.com/");
    expect(analysis.formFactor).toBe("PHONE");
    const lcp: CruxMetricHistory | undefined =
      analysis.metrics["largest_contentful_paint"];
    expect(lcp?.p75Values).toHaveLength(8);
    expect(lcp?.latestP75).toBe(3700);
    expect(lcp?.goodPercentages[0]).toBe(70);
    expect(Object.keys(analysis.metrics)).not.toContain("some_future_metric");
    expect(analysis.collectionPeriods).toHaveLength(2);
    expect(analysis.collectionPeriods[0]?.first).toBe("2026-01-01");
  });

  it("parses string-encoded CLS and NaN densities", () => {
    const analysis = parseCruxHistoryPayload(
      {
        record: {
          collectionPeriods: [],
          metrics: {
            cumulative_layout_shift: {
              percentilesTimeseries: { p75s: ["0.08", null, "bad"] },
              histogramTimeseries: [
                { densities: [0.8, "NaN", null] },
                { densities: [] },
                { densities: [] },
              ],
            },
          },
        },
      },
      { target: "https://example.com/" },
    );
    const cls = analysis.metrics["cumulative_layout_shift"];
    expect(cls?.p75Values).toEqual([0.08, null, null]);
    expect(cls?.goodPercentages).toEqual([80, null, null]);
    expect(analysis.formFactor).toBe("ALL");
  });
});

describe("detectCruxTrends", () => {
  it("detects degrading, improving, and stable trends", () => {
    const trends = detectCruxTrends({
      largest_contentful_paint: cruxHistory([
        2000, 2000, 2000, 2000, 3000, 3000, 3000, 3000,
      ]),
    });
    expect(trends["largest_contentful_paint"]?.direction).toBe("degrading");
    expect(trends["largest_contentful_paint"]?.changePct).toBe(50);

    const improving = detectCruxTrends({
      largest_contentful_paint: cruxHistory([
        3000, 3000, 3000, 3000, 2000, 2000, 2000, 2000,
      ]),
    });
    expect(improving["largest_contentful_paint"]?.direction).toBe("improving");

    const stable = detectCruxTrends({
      largest_contentful_paint: cruxHistory([
        2000, 2010, 1990, 2005, 2002, 1998, 2001, 2000,
      ]),
    });
    expect(stable["largest_contentful_paint"]?.direction).toBe("stable");
  });

  it("reports insufficient data below 8 valid points", () => {
    const trends = detectCruxTrends({
      largest_contentful_paint: cruxHistory([
        2000,
        2000,
        null,
        null,
        null,
        null,
        null,
        null,
      ]),
    });
    expect(trends["largest_contentful_paint"]?.direction).toBe(
      "insufficient_data",
    );
  });
});

describe("summarizeCruxHistory", () => {
  it("flags regressions and threshold crossings", () => {
    const summary: CruxHistorySummary = summarizeCruxHistory(
      parseCruxHistoryPayload(
        historyFixture([2000, 2000, 2000, 2000, 4500, 4500, 4500, 4500]),
        { target: "https://example.com/" },
      ),
    );
    const lcp: CruxMetricSummary | undefined = summary.metrics.find(
      (item) => item.metric === "largest_contentful_paint",
    );
    expect(lcp?.headline).toBe("regression");
    expect(lcp?.latestRating).toBe("poor");
    expect(lcp?.thresholdCrossed).toBe(true);
    expect(summary.regressing).toContain("LCP");
    expect(summary.improving).toEqual([]);
  });

  it("flags improvements", () => {
    const summary = summarizeCruxHistory(
      parseCruxHistoryPayload(
        historyFixture([4500, 4500, 4500, 4500, 2000, 2000, 2000, 2000]),
        { target: "https://example.com/" },
      ),
    );
    expect(summary.improving).toContain("LCP");
    expect(summary.regressing).toEqual([]);
  });
});

describe("compareFieldVsLab", () => {
  function analysis(input: {
    perfScore: number | null;
    lcpLab: number;
    lcpField: number;
    lcpFieldRating: string;
  }): PsiPageAnalysis {
    return analyzePsiPayload(psiFixture(input), {
      url: "https://example.com/",
      strategy: "mobile",
    });
  }

  it("flags lab-worse LCP and agreement on CLS", () => {
    const rows: FieldLabComparison[] = compareFieldVsLab(
      analysis({
        perfScore: 0.72,
        lcpLab: 4200,
        lcpField: 3800,
        lcpFieldRating: "NEEDS_IMPROVEMENT",
      }),
    );
    const lcp = rows.find((row) => row.metric === "largest_contentful_paint");
    // Lab 4200ms is poor, field 3800ms needs-improvement: lab is worse.
    expect(lcp?.outcome).toBe("lab-worse");
    const cls = rows.find((row) => row.metric === "cumulative_layout_shift");
    expect(cls?.outcome).toBe("agree");
  });
});

describe("verdictPagePerformance", () => {
  it("returns poor for a slow page with reasons", () => {
    const result: PerformanceVerdictResult = verdictPagePerformance(
      analyzePsiPayload(
        psiFixture({
          perfScore: 0.72,
          lcpLab: 4200,
          lcpField: 3800,
          lcpFieldRating: "NEEDS_IMPROVEMENT",
        }),
        { url: "https://example.com/", strategy: "mobile" },
      ),
    );
    expect(result.verdict).toBe("poor");
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it("passes a fast page", () => {
    const result = verdictPagePerformance(
      analyzePsiPayload(
        {
          lighthouseResult: {
            categories: { performance: { score: 0.98 } },
            audits: {
              "largest-contentful-paint": {
                numericValue: 1800,
                displayValue: "1.8 s",
                score: 0.99,
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
            },
          },
          loadingExperience: {
            metrics: {
              LARGEST_CONTENTFUL_PAINT_MS: {
                percentile: 2000,
                category: "GOOD",
              },
              CUMULATIVE_LAYOUT_SHIFT_SCORE: {
                percentile: 4,
                category: "GOOD",
              },
              FIRST_CONTENTFUL_PAINT_MS: {
                percentile: 1600,
                category: "GOOD",
              },
            },
          },
        },
        { url: "https://example.com/", strategy: "mobile" },
      ),
    );
    expect(result.verdict).toBe("pass");
  });
});
