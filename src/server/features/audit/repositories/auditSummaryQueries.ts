import { countDistinct, eq } from "drizzle-orm";
import { db } from "@/db";
import { auditIssues, auditLighthouseResults, auditPages } from "@/db/schema";

/**
 * Distinct-page counts per issue type for one audit — link-level issues
 * write one row per occurrence, and consumers phrase this as "N pages".
 * Lives beside AuditRepository (same pattern as rank-tracking's
 * snapshotQueries) to keep the main repository under the file-size limit.
 */
export async function getIssueTypePageCountsForAudit(auditId: string) {
  return db
    .select({
      issueType: auditIssues.issueType,
      severity: auditIssues.severity,
      pages: countDistinct(auditIssues.pageUrl),
    })
    .from(auditIssues)
    .where(eq(auditIssues.auditId, auditId))
    .groupBy(auditIssues.issueType, auditIssues.severity);
}

/**
 * Per-page signals feeding the audit health score: persisted content/schema
 * enrichment plus the crawl-shape columns scoring reads (indexability,
 * images, fetch outcome, response time).
 */
export async function getPageScoreSignalsForAudit(auditId: string) {
  return db
    .select({
      contentScore: auditPages.contentScore,
      schemaStatus: auditPages.schemaStatus,
      wordCount: auditPages.wordCount,
      isIndexable: auditPages.isIndexable,
      imagesTotal: auditPages.imagesTotal,
      imagesMissingAlt: auditPages.imagesMissingAlt,
      fetchClass: auditPages.fetchClass,
      statusCode: auditPages.statusCode,
      responseTimeMs: auditPages.responseTimeMs,
    })
    .from(auditPages)
    .where(eq(auditPages.auditId, auditId));
}

/** Successful Lighthouse performance scores for the perf sub-score. */
export async function getLighthouseScoresForAudit(auditId: string) {
  return db
    .select({
      performanceScore: auditLighthouseResults.performanceScore,
    })
    .from(auditLighthouseResults)
    .where(eq(auditLighthouseResults.auditId, auditId));
}
