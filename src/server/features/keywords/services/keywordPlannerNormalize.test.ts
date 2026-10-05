import { describe, expect, it } from "vitest";
import type { AdsKeywordIdeaItem } from "@/server/lib/dataforseo";
import {
  expandKeywordsResultSchema,
  groupIdeasByCompetition,
  keywordVolumesResultSchema,
  normalizeCompetition,
  normalizePlannerIdea,
  normalizePlannerIdeas,
  sortIdeasByVolumeDesc,
  type MonthlyVolume,
  type PlannerCompetition,
  type PlannerGroup,
  type PlannerIdea,
} from "./keywordPlannerNormalize";

function monthlyVolumes(): MonthlyVolume[] {
  return [{ year: 2026, month: 5, volume: 1300 }];
}

describe("normalizeCompetition", () => {
  it("passes through known buckets and defaults the rest", () => {
    const cases: Array<[string | null | undefined, PlannerCompetition]> = [
      ["LOW", "LOW"],
      ["medium", "MEDIUM"],
      [" HIGH ", "HIGH"],
      ["UNKNOWN", "UNKNOWN"],
      [null, "UNSPECIFIED"],
      [undefined, "UNSPECIFIED"],
      ["SOMETHING_ELSE", "UNSPECIFIED"],
    ];
    for (const [raw, expected] of cases) {
      expect(normalizeCompetition(raw)).toBe(expected);
    }
  });
});

describe("normalizePlannerIdea", () => {
  it("maps a Google Ads item to the planner shape with dollars CPC", () => {
    const idea = normalizePlannerIdea({
      keyword: "SEO Audit",
      search_volume: 8100,
      cpc: 4.2,
      competition: "HIGH",
      competition_index: 87,
      monthly_searches: [
        { year: 2026, month: 5, search_volume: 8100 },
        { year: 2026, month: 13, search_volume: 1 },
      ],
    });

    expect(idea).toEqual({
      keyword: "seo audit",
      avgMonthlySearches: 8100,
      competition: "HIGH",
      competitionIndex: 87,
      cpc: 4.2,
      monthlyVolumes: [{ year: 2026, month: 5, volume: 8100 }],
    });
  });

  it("keeps the trailing 12 monthly volumes", () => {
    const monthly = Array.from({ length: 24 }, (_, index) => ({
      year: 2024 + Math.floor(index / 12),
      month: (index % 12) + 1,
      search_volume: 100 + index,
    }));
    const idea = normalizePlannerIdea({
      keyword: "seo tools",
      monthly_searches: monthly,
    });

    expect(idea?.monthlyVolumes).toHaveLength(12);
    expect(idea?.monthlyVolumes[0]).toEqual({
      year: 2025,
      month: 1,
      volume: 112,
    });
  });

  it("returns null for empty keywords and nulls for missing metrics", () => {
    expect(normalizePlannerIdea({ keyword: "  " })).toBeNull();
    expect(normalizePlannerIdea({ keyword: undefined })).toBeNull();
    expect(normalizePlannerIdea({ keyword: "seo" })).toMatchObject({
      avgMonthlySearches: null,
      competition: "UNSPECIFIED",
      competitionIndex: null,
      cpc: null,
      monthlyVolumes: [],
    });
  });
});

describe("normalizePlannerIdeas", () => {
  it("dedupes case variants keeping the strongest volume", () => {
    const items: AdsKeywordIdeaItem[] = [
      { keyword: "seo audit", search_volume: 100 },
      { keyword: "SEO Audit", search_volume: 900 },
      { keyword: undefined },
    ];

    const ideas = normalizePlannerIdeas(items);

    expect(ideas).toHaveLength(1);
    expect(ideas[0]).toMatchObject({
      keyword: "seo audit",
      avgMonthlySearches: 900,
    });
  });
});

describe("sortIdeasByVolumeDesc", () => {
  it("sorts nulls last with a keyword tie-break", () => {
    const ideas: PlannerIdea[] = [
      {
        keyword: "b",
        avgMonthlySearches: null,
        competition: "LOW",
        competitionIndex: null,
        cpc: null,
        monthlyVolumes: monthlyVolumes(),
      },
      {
        keyword: "c",
        avgMonthlySearches: 100,
        competition: "LOW",
        competitionIndex: null,
        cpc: null,
        monthlyVolumes: monthlyVolumes(),
      },
      {
        keyword: "a",
        avgMonthlySearches: 100,
        competition: "LOW",
        competitionIndex: null,
        cpc: null,
        monthlyVolumes: monthlyVolumes(),
      },
    ];

    expect(sortIdeasByVolumeDesc(ideas).map((idea) => idea.keyword)).toEqual([
      "a",
      "c",
      "b",
    ]);
  });
});

describe("groupIdeasByCompetition", () => {
  it("groups in bucket order with top keywords by volume", () => {
    const ideas: PlannerIdea[] = [
      {
        keyword: "low-one",
        avgMonthlySearches: 50,
        competition: "LOW",
        competitionIndex: 10,
        cpc: 1,
        monthlyVolumes: monthlyVolumes(),
      },
      {
        keyword: "high-one",
        avgMonthlySearches: 900,
        competition: "HIGH",
        competitionIndex: 90,
        cpc: 5,
        monthlyVolumes: monthlyVolumes(),
      },
      {
        keyword: "high-two",
        avgMonthlySearches: 100,
        competition: "HIGH",
        competitionIndex: 80,
        cpc: 4,
        monthlyVolumes: monthlyVolumes(),
      },
    ];

    const groups: PlannerGroup[] = groupIdeasByCompetition(ideas, 1);

    expect(groups).toEqual([
      { competition: "HIGH", count: 2, topKeywords: ["high-one"] },
      { competition: "LOW", count: 1, topKeywords: ["low-one"] },
    ]);
  });

  it("omits empty buckets", () => {
    expect(groupIdeasByCompetition([])).toEqual([]);
  });
});

describe("planner result schemas", () => {
  it("accepts the service result shapes", () => {
    expect(
      expandKeywordsResultSchema.safeParse({
        seedKeywords: ["seo tools"],
        ideas: [],
        groups: [],
        source: "google_ads",
      }).success,
    ).toBe(true);
    expect(
      keywordVolumesResultSchema.safeParse({
        keywords: [],
        source: "google_ads",
      }).success,
    ).toBe(true);
  });
});
