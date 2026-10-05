import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BillingCustomerContext } from "@/server/billing/subscription";

const mocks = vi.hoisted(() => ({
  adsIdeas: vi.fn(),
  adsSearchVolume: vi.fn(),
  getCached: vi.fn(),
  setCached: vi.fn(async () => {}),
  buildCacheKey: vi.fn(
    async (prefix: string, params: Record<string, unknown>) =>
      `${prefix}:${JSON.stringify(params)}`,
  ),
}));

// Same seam as research-data.test.ts: mock the metered client, keep the real
// normalization, so no test spends DataForSEO credits or touches the network.
vi.mock("@/server/lib/dataforseo", () => ({
  createDataforseoClient: vi.fn(() => ({
    keywords: {
      adsIdeas: mocks.adsIdeas,
      adsSearchVolume: mocks.adsSearchVolume,
    },
  })),
}));

vi.mock("@/server/lib/r2-cache", () => ({
  buildCacheKey: mocks.buildCacheKey,
  getCached: mocks.getCached,
  setCached: mocks.setCached,
  CACHE_TTL: { researchResult: 86400 },
}));

import { KeywordPlannerService } from "./KeywordPlannerService";

const billingCustomer: BillingCustomerContext = {
  organizationId: "org_1",
  userId: "user_1",
  userEmail: "alice@example.com",
};

function ideasFixture(keyword: string) {
  return [
    {
      keyword: `${keyword} audit`,
      search_volume: 800,
      cpc: 3.1,
      competition: "HIGH",
      competition_index: 85,
      monthly_searches: [{ year: 2026, month: 5, search_volume: 800 }],
    },
    {
      keyword: `${keyword} checker`,
      search_volume: 5000,
      cpc: 1.2,
      competition: "LOW",
      competition_index: 12,
      monthly_searches: [{ year: 2026, month: 5, search_volume: 5000 }],
    },
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCached.mockResolvedValue(null);
});

describe("KeywordPlannerService.expandKeywords", () => {
  it("fans out per seed then merges, dedupes, sorts, and groups", async () => {
    mocks.adsIdeas
      .mockResolvedValueOnce(ideasFixture("seo"))
      .mockResolvedValueOnce([
        {
          keyword: "SEO Audit",
          search_volume: 900,
          cpc: 3.5,
          competition: "HIGH",
          competition_index: 88,
          monthly_searches: [{ year: 2026, month: 5, search_volume: 900 }],
        },
        ...ideasFixture("site"),
      ]);

    const result = await KeywordPlannerService.expandKeywords(
      { seeds: ["seo", "site"], limit: 10 },
      billingCustomer,
    );

    expect(mocks.adsIdeas).toHaveBeenCalledTimes(2);
    expect(result.source).toBe("google_ads");
    expect(result.seedKeywords).toEqual(["seo", "site"]);
    expect(result.ideas.map((idea) => idea.keyword)).toEqual([
      "seo checker",
      "site checker",
      "seo audit",
      "site audit",
    ]);
    // "SEO Audit" appeared under both seeds; the stronger volume wins.
    expect(
      result.ideas.find((idea) => idea.keyword === "seo audit"),
    ).toMatchObject({ avgMonthlySearches: 900 });
    expect(result.groups).toEqual([
      {
        competition: "HIGH",
        count: 2,
        topKeywords: ["seo audit", "site audit"],
      },
      {
        competition: "LOW",
        count: 2,
        topKeywords: ["seo checker", "site checker"],
      },
    ]);
    expect(mocks.setCached).toHaveBeenCalledOnce();
  });

  it("passes market, limit, and credit feature through to the client", async () => {
    mocks.adsIdeas.mockResolvedValue(ideasFixture("seo"));

    await KeywordPlannerService.expandKeywords(
      {
        seeds: ["Seo"],
        locationCode: 2826,
        languageCode: "en",
        limit: 25,
      },
      billingCustomer,
      "agent",
    );

    expect(mocks.adsIdeas).toHaveBeenCalledWith({
      keyword: "seo",
      locationCode: 2826,
      languageCode: "en",
      limit: 25,
      creditFeature: "agent",
    });
  });

  it("serves cache hits without calling the API", async () => {
    mocks.getCached.mockResolvedValue({
      seedKeywords: ["seo"],
      ideas: [
        {
          keyword: "seo audit",
          avgMonthlySearches: 900,
          competition: "HIGH",
          competitionIndex: 88,
          cpc: 3.5,
          monthlyVolumes: [],
        },
      ],
      groups: [{ competition: "HIGH", count: 1, topKeywords: ["seo audit"] }],
      source: "google_ads",
    });

    const result = await KeywordPlannerService.expandKeywords(
      { seeds: ["seo"] },
      billingCustomer,
    );

    expect(mocks.adsIdeas).not.toHaveBeenCalled();
    expect(result.ideas).toHaveLength(1);
  });

  it("rejects empty and oversized seed lists", async () => {
    await expect(
      KeywordPlannerService.expandKeywords({ seeds: ["   "] }, billingCustomer),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      KeywordPlannerService.expandKeywords(
        { seeds: ["a", "b", "c", "d", "e", "f"] },
        billingCustomer,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(mocks.adsIdeas).not.toHaveBeenCalled();
  });
});

describe("KeywordPlannerService.getKeywordVolumes", () => {
  it("fetches exact metrics in one call preserving provider order", async () => {
    mocks.adsSearchVolume.mockResolvedValue([
      { keyword: "seo audit", search_volume: 900, competition: "HIGH" },
      { keyword: "seo checker", search_volume: 100, competition: "LOW" },
    ]);

    const result = await KeywordPlannerService.getKeywordVolumes(
      { keywords: ["seo audit", "seo checker"] },
      billingCustomer,
      "keyword_research",
    );

    expect(mocks.adsSearchVolume).toHaveBeenCalledWith({
      keywords: ["seo audit", "seo checker"],
      locationCode: 2840,
      languageCode: "en",
      creditFeature: "keyword_research",
    });
    expect(result.keywords.map((row) => row.keyword)).toEqual([
      "seo audit",
      "seo checker",
    ]);
    expect(result.source).toBe("google_ads");
  });

  it("rejects an empty keyword list", async () => {
    await expect(
      KeywordPlannerService.getKeywordVolumes(
        { keywords: [] },
        billingCustomer,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(mocks.adsSearchVolume).not.toHaveBeenCalled();
  });
});
