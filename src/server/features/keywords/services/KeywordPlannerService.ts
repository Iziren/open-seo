import { AppError } from "@/server/lib/errors";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import type { CreditFeature } from "@/shared/billing-credit-features";
import { createDataforseoClient } from "@/server/lib/dataforseo";
import {
  buildCacheKey,
  CACHE_TTL,
  getCached,
  setCached,
} from "@/server/lib/r2-cache";
import { normalizeKeyword } from "@/server/features/keywords/services/research/helpers";
import {
  expandKeywordsInputSchema,
  expandKeywordsResultSchema,
  groupIdeasByCompetition,
  keywordVolumesInputSchema,
  keywordVolumesResultSchema,
  normalizePlannerIdeas,
  sortIdeasByVolumeDesc,
  type ExpandKeywordsInput,
  type ExpandKeywordsResult,
  type KeywordVolumesInput,
  type KeywordVolumesResult,
  type ResolvedExpandKeywordsInput,
  type ResolvedKeywordVolumesInput,
} from "@/server/features/keywords/services/keywordPlannerNormalize";

// Spend is metered inside createDataforseoClient (client.ts
// meterDataforseoCall). Passing creditFeature attributes the call to a
// specific feature; omitting it falls back to the path-derived default, which
// maps every keywords_data/* path to keyword_research.

function parseExpandInput(
  raw: ExpandKeywordsInput,
): ResolvedExpandKeywordsInput {
  const parsed = expandKeywordsInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError(
      "VALIDATION_ERROR",
      parsed.error.issues[0]?.message ?? "Invalid keyword planner input",
    );
  }
  return parsed.data;
}

function parseVolumesInput(
  raw: KeywordVolumesInput,
): ResolvedKeywordVolumesInput {
  const parsed = keywordVolumesInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError(
      "VALIDATION_ERROR",
      parsed.error.issues[0]?.message ?? "Invalid keyword volumes input",
    );
  }
  return parsed.data;
}

function dedupeSeeds(seeds: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const seed of seeds) {
    const normalized = normalizeKeyword(seed);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    unique.push(normalized);
  }
  return unique;
}

// Port of Python generate_keyword_ideas: seed keywords become expanded ideas
// with volume/CPC/competition, sorted by volume descending and truncated to
// the limit. DataForSEO's keywords_for_keywords takes one seed per request at
// a flat fee, so fan out per seed (like the research_keywords MCP tool) and
// merge the results.
async function expandKeywords(
  input: ExpandKeywordsInput,
  billingCustomer: BillingCustomerContext,
  creditFeature?: CreditFeature,
): Promise<ExpandKeywordsResult> {
  const resolved = parseExpandInput(input);
  const seedKeywords = dedupeSeeds(resolved.seeds);
  if (seedKeywords.length === 0) {
    throw new AppError(
      "VALIDATION_ERROR",
      "At least one seed keyword is required",
    );
  }

  const cacheKey = await buildCacheKey("kw:planner:ideas", {
    seeds: seedKeywords,
    locationCode: resolved.locationCode,
    languageCode: resolved.languageCode,
    limit: resolved.limit,
  });
  const cached = expandKeywordsResultSchema.safeParse(
    await getCached(cacheKey),
  );
  if (cached.success && cached.data.ideas.length > 0) return cached.data;

  const dataforseo = createDataforseoClient(billingCustomer);
  const perSeed = await Promise.all(
    seedKeywords.map((seed) =>
      dataforseo.keywords.adsIdeas({
        keyword: seed,
        locationCode: resolved.locationCode,
        languageCode: resolved.languageCode,
        limit: resolved.limit,
        creditFeature,
      }),
    ),
  );

  const ideas = sortIdeasByVolumeDesc(
    normalizePlannerIdeas(perSeed.flat()),
  ).slice(0, resolved.limit);
  const result: ExpandKeywordsResult = {
    seedKeywords,
    ideas,
    groups: groupIdeasByCompetition(ideas),
    source: "google_ads",
  };
  await setCached(cacheKey, result, CACHE_TTL.researchResult);
  return result;
}

// Port of Python get_keyword_volumes: exact metrics for known keywords.
// Provider order is preserved (no volume sort), matching the Python output.
async function getKeywordVolumes(
  input: KeywordVolumesInput,
  billingCustomer: BillingCustomerContext,
  creditFeature?: CreditFeature,
): Promise<KeywordVolumesResult> {
  const resolved = parseVolumesInput(input);
  const keywords = dedupeSeeds(resolved.keywords);
  if (keywords.length === 0) {
    throw new AppError("VALIDATION_ERROR", "At least one keyword is required");
  }

  const cacheKey = await buildCacheKey("kw:planner:volumes", {
    keywords,
    locationCode: resolved.locationCode,
    languageCode: resolved.languageCode,
  });
  const cached = keywordVolumesResultSchema.safeParse(
    await getCached(cacheKey),
  );
  if (cached.success && cached.data.keywords.length > 0) return cached.data;

  const dataforseo = createDataforseoClient(billingCustomer);
  const items = await dataforseo.keywords.adsSearchVolume({
    keywords,
    locationCode: resolved.locationCode,
    languageCode: resolved.languageCode,
    creditFeature,
  });

  const result: KeywordVolumesResult = {
    keywords: normalizePlannerIdeas(items),
    source: "google_ads",
  };
  await setCached(cacheKey, result, CACHE_TTL.researchResult);
  return result;
}

export const KeywordPlannerService = {
  expandKeywords,
  getKeywordVolumes,
} as const;
