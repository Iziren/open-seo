import { z } from "zod";
import { sort } from "remeda";
import type { AdsKeywordIdeaItem } from "@/server/lib/dataforseo";
import { normalizeKeyword } from "@/server/features/keywords/services/research/helpers";
import { DEFAULT_LOCATION_CODE } from "@/shared/keyword-locations";

// Google Ads competition buckets, as the Python planner reports them
// (metrics.competition.name, "UNSPECIFIED" when the API sends nothing).
export const plannerCompetitionSchema = z.enum([
  "LOW",
  "MEDIUM",
  "HIGH",
  "UNKNOWN",
  "UNSPECIFIED",
]);
export type PlannerCompetition = z.infer<typeof plannerCompetitionSchema>;

const COMPETITION_BUCKET_ORDER: readonly PlannerCompetition[] = [
  "HIGH",
  "MEDIUM",
  "LOW",
  "UNKNOWN",
  "UNSPECIFIED",
];

export const monthlyVolumeSchema = z.object({
  year: z.number().int(),
  month: z.number().int().min(1).max(12),
  volume: z.number(),
});
export type MonthlyVolume = z.infer<typeof monthlyVolumeSchema>;

// Campaign-planner idea: the Python dict is ported to the repo's camelCase
// convention. DataForSEO's Google Ads items carry a single CPC (already in
// dollars), which stands in for the Python low/high top-of-page bid micros.
export const plannerIdeaSchema = z.object({
  keyword: z.string(),
  avgMonthlySearches: z.number().nullable(),
  competition: plannerCompetitionSchema,
  competitionIndex: z.number().nullable(),
  cpc: z.number().nullable(),
  monthlyVolumes: z.array(monthlyVolumeSchema),
});
export type PlannerIdea = z.infer<typeof plannerIdeaSchema>;

export const plannerGroupSchema = z.object({
  competition: plannerCompetitionSchema,
  count: z.number().int().min(1),
  topKeywords: z.array(z.string()),
});
export type PlannerGroup = z.infer<typeof plannerGroupSchema>;

export const expandKeywordsInputSchema = z.object({
  seeds: z.array(z.string().min(1).max(120)).min(1).max(5),
  locationCode: z.number().int().default(DEFAULT_LOCATION_CODE),
  languageCode: z.string().min(2).max(10).default("en"),
  limit: z.number().int().min(1).max(1000).default(50),
});
export type ExpandKeywordsInput = z.input<typeof expandKeywordsInputSchema>;
export type ResolvedExpandKeywordsInput = z.output<
  typeof expandKeywordsInputSchema
>;

export const keywordVolumesInputSchema = z.object({
  keywords: z.array(z.string().min(1).max(120)).min(1).max(700),
  locationCode: z.number().int().default(DEFAULT_LOCATION_CODE),
  languageCode: z.string().min(2).max(10).default("en"),
});
export type KeywordVolumesInput = z.input<typeof keywordVolumesInputSchema>;
export type ResolvedKeywordVolumesInput = z.output<
  typeof keywordVolumesInputSchema
>;

export const expandKeywordsResultSchema = z.object({
  seedKeywords: z.array(z.string()),
  ideas: z.array(plannerIdeaSchema),
  groups: z.array(plannerGroupSchema),
  source: z.literal("google_ads"),
});
export type ExpandKeywordsResult = z.infer<typeof expandKeywordsResultSchema>;

export const keywordVolumesResultSchema = z.object({
  keywords: z.array(plannerIdeaSchema),
  source: z.literal("google_ads"),
});
export type KeywordVolumesResult = z.infer<typeof keywordVolumesResultSchema>;

export function normalizeCompetition(
  raw: string | null | undefined,
): PlannerCompetition {
  if (!raw) return "UNSPECIFIED";
  const value = raw.trim().toUpperCase();
  if (
    value === "LOW" ||
    value === "MEDIUM" ||
    value === "HIGH" ||
    value === "UNKNOWN"
  ) {
    return value;
  }
  return "UNSPECIFIED";
}

// Python keeps the trailing 12 monthly volumes per idea.
const MAX_MONTHLY_VOLUMES = 12;

export function normalizePlannerIdea(
  item: AdsKeywordIdeaItem,
): PlannerIdea | null {
  const keyword = item.keyword?.trim();
  if (!keyword) return null;

  const monthlyVolumes = (item.monthly_searches ?? [])
    .map((entry) => ({
      year: entry.year ?? 0,
      month: entry.month ?? 0,
      volume: entry.search_volume ?? 0,
    }))
    .filter((entry) => entry.month >= 1 && entry.month <= 12)
    .slice(-MAX_MONTHLY_VOLUMES);

  return {
    keyword: normalizeKeyword(keyword),
    avgMonthlySearches: item.search_volume ?? null,
    competition: normalizeCompetition(item.competition),
    competitionIndex: item.competition_index ?? null,
    cpc: item.cpc ?? null,
    monthlyVolumes,
  };
}

export function normalizePlannerIdeas(
  items: AdsKeywordIdeaItem[],
): PlannerIdea[] {
  const byKeyword = new Map<string, PlannerIdea>();
  for (const item of items) {
    const idea = normalizePlannerIdea(item);
    if (!idea) continue;
    const existing = byKeyword.get(idea.keyword);
    // One keyword can surface under several seeds; keep the strongest volume.
    if (
      !existing ||
      (idea.avgMonthlySearches ?? 0) > (existing.avgMonthlySearches ?? 0)
    ) {
      byKeyword.set(idea.keyword, idea);
    }
  }
  return [...byKeyword.values()];
}

// Remeda sort (not Array.sort): oxlint forbids in-place mutation.
export function sortIdeasByVolumeDesc(ideas: PlannerIdea[]): PlannerIdea[] {
  return sort(
    ideas,
    (a, b) =>
      (b.avgMonthlySearches ?? 0) - (a.avgMonthlySearches ?? 0) ||
      a.keyword.localeCompare(b.keyword),
  );
}

export function groupIdeasByCompetition(
  ideas: PlannerIdea[],
  topN = 3,
): PlannerGroup[] {
  const groups: PlannerGroup[] = [];
  for (const competition of COMPETITION_BUCKET_ORDER) {
    const bucket = sortIdeasByVolumeDesc(
      ideas.filter((idea) => idea.competition === competition),
    );
    if (bucket.length === 0) continue;
    groups.push({
      competition,
      count: bucket.length,
      topKeywords: bucket.slice(0, topN).map((idea) => idea.keyword),
    });
  }
  return groups;
}
