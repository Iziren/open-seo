import { describe, expect, it } from "vitest";
import {
  analyzeLcpSubparts,
  decomposeFieldLcpSubparts,
  decomposeLabLcpAudit,
  LCP_SUBPART_LABELS,
  type LabLcpAuditInput,
  type LcpBreakdown,
  type LcpDominantSubpart,
  type LcpSubpartKey,
  type LcpSubpartSet,
} from "./perf-lcp";

const _typeChecks: { key: LcpSubpartKey; set: LcpSubpartSet } = {
  key: "ttfb",
  set: { ttfbMs: 1, loadDelayMs: 1, loadDurationMs: 1, renderDelayMs: 1 },
};
void _typeChecks;

describe("decomposeLabLcpAudit", () => {
  it("reads details.phases when present", () => {
    const audit: LabLcpAuditInput = {
      numericValue: 4200,
      details: {
        phases: {
          ttfb: 1100,
          loadDelay: 200,
          loadDuration: 500,
          renderDelay: 2400,
        },
      },
    };
    const { overallLcpMs, subparts } = decomposeLabLcpAudit(audit);
    expect(overallLcpMs).toBe(4200);
    expect(subparts.renderDelayMs).toBe(2400);
  });

  it("scans details.items for phase and timing pairs", () => {
    const audit: LabLcpAuditInput = {
      numericValue: 4200,
      details: {
        items: [
          { phase: "Time to first byte", timing: 1100 },
          { phase: "Resource load delay", timingMs: 200 },
          { stat: "Resource load duration", numericValue: 500 },
          { phase: "Element render delay", duration: 2400 },
          { phase: "Unrelated", timing: 5 },
        ],
      },
    };
    const { subparts } = decomposeLabLcpAudit(audit);
    expect(subparts).toEqual({
      ttfbMs: 1100,
      loadDelayMs: 200,
      loadDurationMs: 500,
      renderDelayMs: 2400,
    });
  });

  it("handles missing audits and empty details", () => {
    expect(decomposeLabLcpAudit(undefined).overallLcpMs).toBeNull();
    const { subparts } = decomposeLabLcpAudit({});
    expect(Object.values(subparts).every((value) => value == null)).toBe(true);
  });
});

describe("decomposeFieldLcpSubparts", () => {
  it("reads CrUX subpart p75s", () => {
    const { overallLcpMs, subparts } = decomposeFieldLcpSubparts({
      largest_contentful_paint: { percentiles: { p75: 4200 } },
      largest_contentful_paint_image_time_to_first_byte: {
        percentiles: { p75: 1100 },
      },
      largest_contentful_paint_image_resource_load_delay: {
        percentiles: { p75: 200 },
      },
      largest_contentful_paint_image_resource_load_duration: {
        percentiles: { p75: 500 },
      },
      largest_contentful_paint_image_element_render_delay: {
        percentiles: { p75: 2400 },
      },
    });
    expect(overallLcpMs).toBe(4200);
    expect(subparts.renderDelayMs).toBe(2400);
  });

  it("returns nulls for missing metrics", () => {
    const { overallLcpMs, subparts } = decomposeFieldLcpSubparts({});
    expect(overallLcpMs).toBeNull();
    expect(subparts.ttfbMs).toBeNull();
  });
});

describe("analyzeLcpSubparts", () => {
  it("flags the dominant subpart with its fix", () => {
    const breakdown: LcpBreakdown = analyzeLcpSubparts({
      overallLcpMs: 4200,
      subparts: {
        ttfbMs: 1100,
        loadDelayMs: 200,
        loadDurationMs: 500,
        renderDelayMs: 2400,
      },
      source: "lab",
    });
    const dominant: LcpDominantSubpart[] = breakdown.dominant;
    expect(dominant.map((item) => item.key)).toEqual(["renderDelay"]);
    expect(dominant[0]?.share).toBeCloseTo(0.57, 2);
    expect(breakdown.recommendations).toHaveLength(1);
    expect(breakdown.recommendations[0]).toContain("render-blocking");
    expect(breakdown.totalExplainedMs).toBe(4200);
    expect(LCP_SUBPART_LABELS.renderDelay).toBe("Element render delay");
  });

  it("flags every subpart above the 40% share threshold", () => {
    const breakdown = analyzeLcpSubparts({
      overallLcpMs: 2000,
      subparts: {
        ttfbMs: 900,
        loadDelayMs: null,
        loadDurationMs: 900,
        renderDelayMs: 100,
      },
      source: "field",
    });
    expect(breakdown.dominant).toHaveLength(2);
    expect(breakdown.dominant.map((item) => item.key)).toContain(
      "loadDuration",
    );
    expect(breakdown.dominant.map((item) => item.key)).toContain("ttfb");
    expect(breakdown.recommendations.join(" ")).toContain("TTFB");
  });

  it("reports no dominance without an overall value", () => {
    const breakdown = analyzeLcpSubparts({
      overallLcpMs: null,
      subparts: {
        ttfbMs: 900,
        loadDelayMs: 100,
        loadDurationMs: 100,
        renderDelayMs: 100,
      },
      source: "field",
    });
    expect(breakdown.dominant).toEqual([]);
    expect(breakdown.recommendations).toEqual([]);
    expect(breakdown.totalExplainedMs).toBe(1200);
  });
});
