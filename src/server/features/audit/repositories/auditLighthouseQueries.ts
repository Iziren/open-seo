import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { auditLighthouseResults, auditPages, audits } from "@/db/schema";
import { executeInBatches } from "@/db/runBatch";
import { deterministicAuditRowId } from "@/server/lib/audit/ids";
import type { LighthouseResult } from "@/server/lib/audit/types";

/**
 * Stored Lighthouse result writes/reads. Lives beside AuditRepository (same
 * pattern as auditSummaryQueries) to keep the main repository under the
 * file-size limit. Re-exported through AuditRepository so callers are
 * unaffected.
 */
export async function insertLighthouseResults(
  auditId: string,
  lighthouseResults: LighthouseResult[],
) {
  const rows = await Promise.all(
    lighthouseResults.map(async (result) => ({
      id: await deterministicAuditRowId(
        auditId,
        result.pageId,
        result.strategy,
      ),
      auditId,
      pageId: result.pageId,
      strategy: result.strategy,
      performanceScore: result.performanceScore,
      accessibilityScore: result.accessibilityScore,
      bestPracticesScore: result.bestPracticesScore,
      seoScore: result.seoScore,
      lcpMs: result.lcpMs,
      cls: result.cls,
      inpMs: result.inpMs,
      ttfbMs: result.ttfbMs,
      errorMessage: result.errorMessage ?? null,
      r2Key: result.r2Key ?? null,
      payloadSizeBytes: result.payloadSizeBytes ?? null,
    })),
  );
  // The persistence step is retryable after its paid provider result has been
  // checkpointed, so repeated writes must stay idempotent.
  await executeInBatches(rows, (tx, row) => {
    const { id: _id, auditId: _auditId, ...dataColumns } = row;
    return tx.insert(auditLighthouseResults).values(row).onConflictDoUpdate({
      target: auditLighthouseResults.id,
      set: dataColumns,
    });
  });
}

export async function getLighthouseResultById(input: {
  lighthouseResultId: string;
  projectId: string;
}) {
  const lighthouse = await db.query.auditLighthouseResults.findFirst({
    where: eq(auditLighthouseResults.id, input.lighthouseResultId),
  });

  if (!lighthouse) {
    return null;
  }

  const [parentAudit, page] = await Promise.all([
    db.query.audits.findFirst({
      where: and(
        eq(audits.id, lighthouse.auditId),
        eq(audits.projectId, input.projectId),
      ),
    }),
    db.query.auditPages.findFirst({
      where: eq(auditPages.id, lighthouse.pageId),
    }),
  ]);

  if (!parentAudit) {
    return null;
  }

  return {
    lighthouse,
    page,
    audit: parentAudit,
  };
}
