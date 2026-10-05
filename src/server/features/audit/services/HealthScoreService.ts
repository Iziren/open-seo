/**
 * Audit-level 0-100 health score.
 *
 * Weights come from the product plan and sum to 100: Technical 22 /
 * Content 23 / On-page 20 / Schema 10 / Perf 10 / AI 10 / Images 5. Every
 * sub-score is derived from persisted audit data (issue rows, per-page
 * content/schema columns, Lighthouse rows) — no external calls, so scoring
 * is deterministic for a given audit.
 *
 * Scoring model: each sub-score starts at 100 and loses points proportional
 * to the share of pages affected (`points * affectedPages / totalPages`), so
 * one broken page on a 200-page site barely moves the needle while a
 * site-wide template defect tanks the category. Results are rounded ints.
 */
import type {
  getIssueTypePageCountsForAudit,
  getLighthouseScoresForAudit,
  getPageScoreSignalsForAudit,
} from "@/server/features/audit/repositories/auditSummaryQueries";

type IssueCountRow = Awaited<
  ReturnType<typeof getIssueTypePageCountsForAudit>
>[number];
type PageSignalRow = Awaited<
  ReturnType<typeof getPageScoreSignalsForAudit>
>[number];
type LighthouseRow = Awaited<
  ReturnType<typeof getLighthouseScoresForAudit>
>[number];

export interface HealthScoreInput {
  issueCounts: IssueCountRow[];
  pageSignals: PageSignalRow[];
  lighthouseScores: LighthouseRow[];
}

export interface HealthScoreBreakdown {
  technical: number;
  content: number;
  onPage: number;
  schema: number;
  perf: number;
  ai: number;
  images: number;
  total: number;
}

export type HealthScoreBand = "poor" | "warn" | "good";

const WEIGHTS = {
  technical: 22,
  content: 23,
  onPage: 20,
  schema: 10,
  perf: 10,
  ai: 10,
  images: 5,
} as const;

interface ScoreContext {
  affected: (issueType: string) => number;
  pages: PageSignalRow[];
  total: number;
  lighthousePerf: number[];
}

function clamp100(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value)));
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function scoreTechnical(ctx: ScoreContext): number {
  // Crawlability + infrastructure. Points sum to 100: a site where every
  // page 500s and every fetch is blocked scores 0 here.
  const points: Array<[string, number]> = [
    ["server-error", 20],
    ["blocked-page", 20],
    ["broken-internal-link", 15],
    ["crawl-rate-limited", 10],
    ["broken-page", 10],
    ["redirect-loop", 10],
    ["redirect-chain", 5],
    ["rate-limited-page", 5],
    ["orphan-page", 3],
    ["no-outgoing-links", 1],
    ["deep-page", 1],
  ];
  const lost = points.reduce(
    (sum, [type, weight]) =>
      sum + weight * (ctx.affected(type) / Math.max(1, ctx.total)),
    0,
  );
  return clamp100(100 - lost);
}

function scoreContent(ctx: ScoreContext): number {
  // The persisted per-page composite carries the E-E-A-T detail; issue
  // rates cover the structural failures (thin/duplicate/low-quality pages
  // drag the average but a single number hides how many pages are at fault).
  const scored = ctx.pages.filter(
    (page): page is PageSignalRow & { contentScore: number } =>
      page.contentScore !== null,
  );
  const hygieneAffected = Math.min(
    ctx.total,
    ctx.affected("thin-content") +
      ctx.affected("duplicate-content") +
      ctx.affected("low-content-quality"),
  );
  const hygiene = 100 * (1 - hygieneAffected / Math.max(1, ctx.total));
  if (scored.length === 0) return clamp100(hygiene);
  return clamp100(
    0.7 * mean(scored.map((page) => page.contentScore)) + 0.3 * hygiene,
  );
}

function scoreOnPage(ctx: ScoreContext): number {
  // Head tags, headings, duplicates, canonical/indexability directives.
  const points: Array<[string, number]> = [
    ["missing-title", 20],
    ["missing-meta-description", 12],
    ["missing-h1", 10],
    ["duplicate-title", 8],
    ["duplicate-meta-description", 6],
    ["multiple-h1", 6],
    ["canonical-conflict", 6],
    ["title-too-long", 4],
    ["title-too-short", 4],
    ["meta-description-too-long", 3],
    ["meta-description-too-short", 3],
    ["heading-order-skip", 3],
    ["noindex-page", 2],
    ["canonicalized-page", 2],
  ];
  const lost = points.reduce(
    (sum, [type, weight]) =>
      sum + weight * (ctx.affected(type) / Math.max(1, ctx.total)),
    0,
  );
  return clamp100(100 - lost);
}

function scoreSchema(ctx: ScoreContext): number {
  // Missing markup is neutral-to-mild (not every template needs rich
  // results) so it earns partial credit; invalid markup earns nothing. The
  // invalid-structured-data issue mirrors the invalid count, so no extra
  // penalty here — the verdict IS the score.
  const statuses = ctx.pages
    .map((page) => page.schemaStatus)
    .filter((status) => status !== null);
  if (statuses.length === 0) return 75;
  const valid = statuses.filter((status) => status === "valid").length;
  const missing = statuses.filter((status) => status === "missing").length;
  return clamp100((100 * (valid + 0.6 * missing)) / statuses.length);
}

function scorePerf(ctx: ScoreContext): number {
  // Lighthouse performance average blended with the TTFB signal every audit
  // has. Audits without Lighthouse degrade to the TTFB-only component
  // instead of failing or zeroing the category.
  const ttfb =
    100 * (1 - ctx.affected("slow-response") / Math.max(1, ctx.total));
  if (ctx.lighthousePerf.length === 0) return clamp100(ttfb);
  return clamp100(0.7 * mean(ctx.lighthousePerf) + 0.3 * ttfb);
}

function scoreAi(ctx: ScoreContext): number {
  // AI-search readiness from signals the crawl already holds — no external
  // API. Rationale per input: app shells have no server-rendered text for
  // crawlers that don't execute JS; valid structured data feeds grounded AI
  // answers and attribution; noindexed pages are excluded from AI indexes
  // too; blocked/rate-limited fetches deny AI crawlers the same way.
  const rate = (count: number) => count / Math.max(1, ctx.total);
  const statuses = ctx.pages
    .map((page) => page.schemaStatus)
    .filter((status) => status !== null);
  const validRate =
    statuses.length === 0
      ? 1
      : statuses.filter((status) => status === "valid").length /
        statuses.length;
  const unreachable = ctx.pages.filter(
    (page) =>
      page.fetchClass === "blocked" || page.fetchClass === "rate_limited",
  ).length;
  const lost =
    40 * rate(ctx.affected("spa-shell")) +
    25 * (1 - validRate) +
    20 * rate(ctx.affected("noindex-page")) +
    15 * rate(unreachable);
  return clamp100(100 - lost);
}

function scoreImages(ctx: ScoreContext): number {
  // Image-level alt coverage across the audit; a site with no images at all
  // has nothing to fix and scores full marks.
  const total = ctx.pages.reduce((sum, page) => sum + page.imagesTotal, 0);
  if (total === 0) return 100;
  const missing = ctx.pages.reduce(
    (sum, page) => sum + page.imagesMissingAlt,
    0,
  );
  return clamp100(100 * (1 - missing / total));
}

function compute(input: HealthScoreInput): HealthScoreBreakdown {
  const affectedByType = new Map<string, number>();
  for (const row of input.issueCounts) {
    affectedByType.set(
      row.issueType,
      (affectedByType.get(row.issueType) ?? 0) + row.pages,
    );
  }
  const ctx: ScoreContext = {
    affected: (issueType) => affectedByType.get(issueType) ?? 0,
    pages: input.pageSignals,
    total: input.pageSignals.length,
    lighthousePerf: input.lighthouseScores
      .map((row) => row.performanceScore)
      .filter((score): score is number => score !== null),
  };
  const technical = scoreTechnical(ctx);
  const content = scoreContent(ctx);
  const onPage = scoreOnPage(ctx);
  const schema = scoreSchema(ctx);
  const perf = scorePerf(ctx);
  const ai = scoreAi(ctx);
  const images = scoreImages(ctx);
  const total = clamp100(
    (WEIGHTS.technical * technical +
      WEIGHTS.content * content +
      WEIGHTS.onPage * onPage +
      WEIGHTS.schema * schema +
      WEIGHTS.perf * perf +
      WEIGHTS.ai * ai +
      WEIGHTS.images * images) /
      100,
  );
  return { technical, content, onPage, schema, perf, ai, images, total };
}

/**
 * UI band for the total: poor below 50, warn from 50 to 89, good at 90+.
 * Matches the registry's critical/warning/info severity conventions.
 */
function scoreBand(total: number): HealthScoreBand {
  if (total < 50) return "poor";
  if (total < 90) return "warn";
  return "good";
}

export const HealthScoreService = {
  WEIGHTS,
  compute,
  scoreBand,
} as const;
