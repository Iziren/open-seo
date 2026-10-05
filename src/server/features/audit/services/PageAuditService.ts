import { fetchAnalyzedPage } from "@/server/lib/audit/fetch-analyzed-page";
import { toJsonRecord, type JsonValue } from "@/server/lib/audit/json-value";
import { enrichPageAnalysis } from "@/server/lib/audit/page-enrichment";
import { scoreGeoCitability } from "@/server/lib/audit/geo-citability";
import { runPageReporters } from "@/server/lib/audit/issues/page-reporters";
import type { CrawledPageResult, PageAnalysis } from "@/server/lib/audit/types";
import type { QualityDimensions } from "@/server/lib/audit/content-quality";

export interface PageAuditIssue {
  issueType: string;
  pageUrl: string;
  details?: Record<string, JsonValue>;
}

export interface PageAuditContentDetail {
  dimensions: QualityDimensions;
  findings: Array<{ code: string; message: string }>;
  readingEase: number;
  topTerm: string | null;
}

export interface PageAuditResult {
  url: string;
  finalUrl: string;
  statusCode: number;
  responseTimeMs: number;
  title: string;
  metaDescription: string;
  wordCount: number;
  h1Count: number;
  imagesTotal: number;
  imagesMissingAlt: number;
  isIndexable: boolean;
  spaShell: boolean;
  contentScore: number | null;
  contentFindings: string[];
  contentDetails: PageAuditContentDetail | null;
  schemaStatus: "missing" | "valid" | "invalid";
  schemaTypes: string[];
  schemaFindings: Array<{ code: string; message: string }>;
  geoScore: number;
  issues: PageAuditIssue[];
}

function toCrawledPage(
  analysis: PageAnalysis,
  enrichment: Awaited<ReturnType<typeof enrichPageAnalysis>>,
  spaShell: boolean,
  statusCode: number,
  responseTimeMs: number,
): CrawledPageResult & { spaShell?: boolean } {
  const headingCount = (level: number) =>
    analysis.headingOrder.filter((h) => h === level).length;
  const robotsDirectives = [analysis.robotsMeta].filter(Boolean).join(",");
  return {
    id: analysis.url,
    url: analysis.url,
    statusCode,
    fetchClass: "ok",
    redirectUrl: null,
    title: analysis.title,
    metaDescription: analysis.metaDescription,
    canonicalUrl: analysis.canonical,
    robotsMeta: analysis.robotsMeta,
    xRobotsTag: null,
    headerCanonicalUrl: null,
    ogTitle: analysis.ogTitle,
    ogDescription: analysis.ogDescription,
    ogImage: analysis.ogImage,
    h1Count: analysis.h1s.filter((h) => h.length > 0).length,
    h2Count: headingCount(2),
    h3Count: headingCount(3),
    h4Count: headingCount(4),
    h5Count: headingCount(5),
    h6Count: headingCount(6),
    headingOrder: analysis.headingOrder,
    wordCount: analysis.wordCount,
    contentHash: null,
    isHtml: true,
    htmlBytes: 0,
    rateLimited: false,
    imagesTotal: analysis.images.length,
    imagesMissingAlt: analysis.images.filter((img) => img.alt === null).length,
    images: analysis.images,
    links: analysis.links,
    hasStructuredData: analysis.hasStructuredData,
    hreflangTags: analysis.hreflangTags,
    isIndexable: !robotsDirectives.toLowerCase().includes("noindex"),
    responseTimeMs,
    crawlDepth: null,
    inSitemap: false,
    contentScore: enrichment.contentScore,
    contentFindings: enrichment.contentFindings,
    schemaStatus: enrichment.schemaStatus,
    schemaTypes: enrichment.schemaTypes,
    schemaFindings: enrichment.schemaFindings,
    nlpSummary: enrichment.nlpSummary,
    spaShell,
  };
}

async function auditPage(input: {
  projectId: string;
  url: string;
}): Promise<PageAuditResult> {
  const {
    finalUrl: startUrl,
    html,
    analysis,
    spaShell,
    statusCode,
    responseTimeMs,
  } = await fetchAnalyzedPage(input.url);

  const enrichment = await enrichPageAnalysis(analysis, html);
  const geo = scoreGeoCitability({ html, url: startUrl });

  // Full quality + NLP detail for the report card. One extra CPU pass over
  // the buffered analysis — no second fetch. The crawl path skips this and
  // persists only the compact enrichment above.
  const [{ analyzeContentQuality }, { analyzeNlp }] = await Promise.all([
    import("@/server/lib/audit/content-quality"),
    import("@/server/lib/audit/nlp-analyze"),
  ]);
  const quality = analyzeContentQuality(analysis);
  const nlp = analyzeNlp({
    text: analysis.bodyText,
    title: analysis.title,
    h1: analysis.h1s[0] ?? "",
  });
  const contentDetails: PageAuditContentDetail = {
    dimensions: quality.dimensions,
    findings: quality.findings.map((finding) => ({
      code: finding.code,
      message: finding.message,
    })),
    readingEase: nlp.readingLevel.fleschReadingEase,
    topTerm: nlp.density.topTerm?.term ?? null,
  };

  const page = toCrawledPage(
    analysis,
    enrichment,
    spaShell,
    statusCode,
    responseTimeMs,
  );
  const issues: PageAuditIssue[] = runPageReporters(page).map((issue) => {
    const details = toJsonRecord(issue.details);
    return {
      issueType: issue.issueType,
      pageUrl: issue.pageUrl,
      ...(details === undefined ? {} : { details }),
    };
  });

  return {
    url: input.url,
    finalUrl: startUrl,
    statusCode,
    responseTimeMs,
    title: analysis.title,
    metaDescription: analysis.metaDescription,
    wordCount: analysis.wordCount,
    h1Count: page.h1Count,
    imagesTotal: page.imagesTotal,
    imagesMissingAlt: page.imagesMissingAlt,
    isIndexable: page.isIndexable,
    spaShell,
    contentScore: enrichment.contentScore,
    contentFindings: enrichment.contentFindings,
    contentDetails,
    schemaStatus: enrichment.schemaStatus,
    schemaTypes: enrichment.schemaTypes,
    schemaFindings: enrichment.schemaFindings,
    geoScore: geo.score,
    issues,
  };
}

export const PageAuditService = {
  auditPage,
} as const;
