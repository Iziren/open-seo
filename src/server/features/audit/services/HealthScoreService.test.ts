import { describe, expect, it } from "vitest";
import {
  HealthScoreService,
  type HealthScoreBand,
  type HealthScoreInput,
} from "@/server/features/audit/services/HealthScoreService";

function page(
  overrides: Partial<HealthScoreInput["pageSignals"][number]> = {},
): HealthScoreInput["pageSignals"][number] {
  return {
    contentScore: 80,
    schemaStatus: "valid",
    wordCount: 400,
    isIndexable: true,
    imagesTotal: 2,
    imagesMissingAlt: 0,
    fetchClass: "ok",
    statusCode: 200,
    responseTimeMs: 200,
    ...overrides,
  };
}

function issue(
  issueType: string,
  pages: number,
): HealthScoreInput["issueCounts"][number] {
  return { issueType, severity: "warning", pages };
}

function input(overrides: Partial<HealthScoreInput> = {}): HealthScoreInput {
  return {
    issueCounts: [],
    pageSignals: [],
    lighthouseScores: [],
    ...overrides,
  };
}

describe("HealthScoreService", () => {
  it("weights sum to 100", () => {
    const total = Object.values(HealthScoreService.WEIGHTS).reduce(
      (sum, weight) => sum + weight,
      0,
    );
    expect(total).toBe(100);
  });

  it("scores an empty audit as nothing-to-flag", () => {
    const breakdown = HealthScoreService.compute(input());
    expect(breakdown).toEqual({
      technical: 100,
      content: 100,
      onPage: 100,
      schema: 75,
      perf: 100,
      ai: 100,
      images: 100,
      total: 98,
    });
  });

  it("scores a near-perfect audit near 100", () => {
    const breakdown = HealthScoreService.compute(
      input({
        pageSignals: [page({ contentScore: 100 }), page({ contentScore: 100 })],
        lighthouseScores: [{ performanceScore: 90 }, { performanceScore: 80 }],
      }),
    );
    expect(breakdown.perf).toBe(90);
    expect(breakdown.total).toBe(99);
  });

  it("tanks technical when every page errors", () => {
    const breakdown = HealthScoreService.compute(
      input({
        pageSignals: [page(), page()],
        issueCounts: [issue("server-error", 2)],
      }),
    );
    expect(breakdown.technical).toBe(80);
  });

  it("derives content from the persisted composite plus hygiene rates", () => {
    const breakdown = HealthScoreService.compute(
      input({
        pageSignals: [page({ contentScore: 60 }), page({ contentScore: 80 })],
        issueCounts: [issue("thin-content", 1)],
      }),
    );
    // avg 70 * 0.7 + hygiene (1 of 2 pages) 50 * 0.3 = 49 + 15 = 64
    expect(breakdown.content).toBe(64);
  });

  it("falls back to hygiene when no page was content-scored", () => {
    const breakdown = HealthScoreService.compute(
      input({ pageSignals: [page({ contentScore: null })] }),
    );
    expect(breakdown.content).toBe(100);
  });

  it("grades schema by verdict mix, neutral when unknown", () => {
    expect(
      HealthScoreService.compute(input({ pageSignals: [page()] })).schema,
    ).toBe(100);
    expect(
      HealthScoreService.compute(
        input({ pageSignals: [page({ schemaStatus: "missing" })] }),
      ).schema,
    ).toBe(60);
    expect(
      HealthScoreService.compute(
        input({ pageSignals: [page({ schemaStatus: "invalid" })] }),
      ).schema,
    ).toBe(0);
  });

  it("degrades perf to TTFB-only without lighthouse data", () => {
    expect(
      HealthScoreService.compute(input({ pageSignals: [page()] })).perf,
    ).toBe(100);
    const slow = HealthScoreService.compute(
      input({
        pageSignals: [page(), page()],
        issueCounts: [issue("slow-response", 1)],
      }),
    );
    expect(slow.perf).toBe(50);
  });

  it("derives AI readiness from shell, schema, indexability, reachability", () => {
    const clean = HealthScoreService.compute(input({ pageSignals: [page()] }));
    expect(clean.ai).toBe(100);
    const shelled = HealthScoreService.compute(
      input({
        pageSignals: [page()],
        issueCounts: [issue("spa-shell", 1)],
      }),
    );
    expect(shelled.ai).toBe(60);
    const blocked = HealthScoreService.compute(
      input({ pageSignals: [page({ fetchClass: "blocked" })] }),
    );
    expect(blocked.ai).toBe(85);
  });

  it("scores images by alt coverage, full marks when imageless", () => {
    expect(
      HealthScoreService.compute(
        input({ pageSignals: [page({ imagesTotal: 0 })] }),
      ).images,
    ).toBe(100);
    expect(
      HealthScoreService.compute(
        input({ pageSignals: [page({ imagesTotal: 4, imagesMissingAlt: 1 })] }),
      ).images,
    ).toBe(75);
  });

  it("bands totals for the UI", () => {
    const cases: Array<[number, HealthScoreBand]> = [
      [49, "poor"],
      [50, "warn"],
      [89, "warn"],
      [90, "good"],
    ];
    for (const [total, band] of cases) {
      expect(HealthScoreService.scoreBand(total)).toBe(band);
    }
  });
});
