/**
 * Shared types for the site audit system.
 */

import { z } from "zod";
import type { PageFetchClass } from "@/shared/audit-fetch-class";
import { MIN_AUDIT_PAGES, PAID_MAX_AUDIT_PAGES } from "@/shared/audit-limits";
import { jsonCodec } from "@/shared/json";

export type LighthouseStrategy = "auto" | "none";

export interface AuditConfig {
  maxPages: number;
  lighthouseStrategy: LighthouseStrategy;
}

// Read-side only (writes stringify a typed AuditConfig). Stored rows may hold
// retired strategies ("all", "manual") from older audits; map them onto the
// closest surviving strategy — and fall back to "auto" on anything unknown —
// instead of failing the whole config parse and making the audit's results
// unviewable.
const lighthouseStrategySchema = z
  .enum(["auto", "all", "manual", "none"])
  .transform(
    (value): LighthouseStrategy =>
      value === "all" ? "auto" : value === "manual" ? "none" : value,
  )
  .catch("auto");

const auditConfigSchema = z.object({
  maxPages: z.number().int().min(MIN_AUDIT_PAGES).max(PAID_MAX_AUDIT_PAGES),
  lighthouseStrategy: lighthouseStrategySchema,
});

const auditConfigCodec = jsonCodec(auditConfigSchema);

export function parseAuditConfig(configRaw: string | null): AuditConfig | null {
  if (!configRaw) return null;
  const result = auditConfigCodec.safeParse(configRaw);
  return result.success ? result.data : null;
}

/** One outgoing link edge, deduped by target URL within a page. */
export interface PageLink {
  targetUrl: string;
  anchor: string | null;
  isInternal: boolean;
  isNofollow: boolean;
}

/** Data extracted from a single page's HTML. */
export interface PageAnalysis {
  url: string;
  statusCode: number;
  redirectUrl: string | null;
  responseTimeMs: number;

  // Head metadata
  title: string;
  metaDescription: string;
  canonical: string | null;
  robotsMeta: string | null;
  ogTitle: string | null;
  ogDescription: string | null;
  ogImage: string | null;

  // Headings
  h1s: string[];
  headingOrder: number[];

  // Content
  wordCount: number;
  bodyText: string;

  // Images
  images: Array<{ src: string | null; alt: string | null }>;

  // Links (normalized, deduped by target)
  links: PageLink[];

  // Structured data
  hasStructuredData: boolean;

  // Hreflang
  hreflangTags: string[];
}

/** Lighthouse result for a single URL+strategy. */
export interface LighthouseResult {
  url: string;
  pageId: string;
  strategy: "mobile" | "desktop";
  performanceScore: number | null;
  accessibilityScore: number | null;
  bestPracticesScore: number | null;
  seoScore: number | null;
  lcpMs: number | null;
  cls: number | null;
  inpMs: number | null;
  ttfbMs: number | null;
  errorMessage?: string | null;
  r2Key?: string | null;
  payloadSizeBytes?: number | null;
}

/** Structured-data verdict for one crawled page. */
export type PageSchemaStatus = "missing" | "valid" | "invalid";

/** One compact schema finding persisted on the page row. */
export interface PageSchemaFinding {
  code: string;
  message: string;
}

/**
 * Compact per-page NLP signals persisted for scoring. Subset of NlpAnalysis
 * small enough to live on the page row: reading level, the densest term,
 * and title/H1 topical coverage.
 */
export interface NlpSummary {
  tokenCount: number;
  readingEase: number;
  grade: number;
  topTerm: string | null;
  topTermDensity: number;
  overOptimized: boolean;
  titleCoverage: number;
  h1Coverage: number;
}

/**
 * Full result of crawling one page. Persisted to the app DB inside the
 * crawl-chunk step; never accumulated in memory or returned as durable
 * step state.
 */
export interface CrawledPageResult {
  id: string;
  url: string;
  statusCode: number;
  fetchClass: PageFetchClass;
  redirectUrl: string | null;
  title: string;
  metaDescription: string;
  canonicalUrl: string | null;
  robotsMeta: string | null;
  xRobotsTag: string | null;
  headerCanonicalUrl: string | null;
  ogTitle: string | null;
  ogDescription: string | null;
  ogImage: string | null;
  h1Count: number;
  h2Count: number;
  h3Count: number;
  h4Count: number;
  h5Count: number;
  h6Count: number;
  headingOrder: number[];
  wordCount: number;
  contentHash: string | null;
  /**
   * True when an HTML document was fetched and analyzed. Gates the content
   * checks in page reporters (an empty-shell HTML page must still be
   * checked; a PDF must not). Transient — not persisted.
   */
  isHtml: boolean;
  /**
   * HTML size read for this page (approximate; capped at MAX_HTML_BYTES).
   * Transient — feeds the crawl window's memory-pressure signal, since
   * response time is measured at headers and says nothing about body size.
   */
  htmlBytes: number;
  /**
   * True when a 429 was retried for this URL (whatever the retry returned).
   * Not persisted — narrows the crawl window so the pages after it are
   * fetched more slowly.
   */
  rateLimited: boolean;
  imagesTotal: number;
  imagesMissingAlt: number;
  images: Array<{ src: string | null; alt: string | null }>;
  links: PageLink[];
  hasStructuredData: boolean;
  hreflangTags: string[];
  isIndexable: boolean;
  responseTimeMs: number;
  /** null = not reached via links (e.g. sitemap-seeded). */
  crawlDepth: number | null;
  inSitemap: boolean;
  /**
   * 0-100 content-quality composite (see content-quality.ts). Undefined on
   * rows that never ran the enrichment (redirects, errors, non-HTML).
   */
  contentScore?: number | null;
  /**
   * Content-quality finding codes driving the low-content-quality reporter.
   * Transient — resolved into issue rows at crawl time, not persisted.
   */
  contentFindings?: string[];
  /** Structured-data verdict; undefined where the enrichment never ran. */
  schemaStatus?: PageSchemaStatus | null;
  /** Deduped JSON-LD @types seen on the page (capped at crawl time). */
  schemaTypes?: string[];
  /** Compact validation findings (capped at crawl time). */
  schemaFindings?: PageSchemaFinding[];
  /** Compact NLP signals for scoring; null when the text was too short. */
  nlpSummary?: NlpSummary | null;
}
