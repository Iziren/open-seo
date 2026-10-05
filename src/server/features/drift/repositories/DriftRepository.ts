import { and, desc, eq, inArray, isNull, lt, or } from "drizzle-orm";
import type { InferInsertModel } from "drizzle-orm";
import { db } from "@/db";
import {
  seoDriftBaselines,
  seoDriftChanges,
  seoDriftSnapshots,
} from "@/db/schema";
import { executeInBatches } from "@/db/runBatch";

// Data access for the drift tables. All SQL lives here; services stay
// fetch/compare orchestration. Every read is project-scoped — drift rows are
// reached either directly (baseline) or through a join on their baseline.

type BaselineInsert = InferInsertModel<typeof seoDriftBaselines>;
type SnapshotInsert = InferInsertModel<typeof seoDriftSnapshots>;
type ChangeInsert = InferInsertModel<typeof seoDriftChanges>;

async function createBaseline(data: BaselineInsert) {
  await db.insert(seoDriftBaselines).values(data);
}

async function getBaseline(input: { baselineId: string; projectId: string }) {
  const rows = await db
    .select()
    .from(seoDriftBaselines)
    .where(
      and(
        eq(seoDriftBaselines.id, input.baselineId),
        eq(seoDriftBaselines.projectId, input.projectId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

async function insertSnapshots(snapshots: SnapshotInsert[]) {
  // executeInBatches caps each statement under D1's bound-parameter limit and
  // keeps chunks atomic; snapshots are insert-once so no conflict handling.
  await executeInBatches(snapshots, (tx, snapshot) =>
    tx.insert(seoDriftSnapshots).values(snapshot),
  );
}

async function getSnapshotsForBaseline(baselineId: string) {
  return (
    db
      .select()
      .from(seoDriftSnapshots)
      .where(eq(seoDriftSnapshots.baselineId, baselineId))
      // Deterministic compare order, independent of capture order.
      .orderBy(seoDriftSnapshots.url)
  );
}

/** Column map reused by the two join queries that read whole snapshots. */
const snapshotColumns = {
  id: seoDriftSnapshots.id,
  baselineId: seoDriftSnapshots.baselineId,
  url: seoDriftSnapshots.url,
  canonicalUrl: seoDriftSnapshots.canonicalUrl,
  title: seoDriftSnapshots.title,
  metaDescription: seoDriftSnapshots.metaDescription,
  h1: seoDriftSnapshots.h1,
  schemaJsonLd: seoDriftSnapshots.schemaJsonLd,
  robotsMeta: seoDriftSnapshots.robotsMeta,
  statusCode: seoDriftSnapshots.statusCode,
  indexable: seoDriftSnapshots.indexable,
  wordCount: seoDriftSnapshots.wordCount,
  externalLinkCount: seoDriftSnapshots.externalLinkCount,
  headersJson: seoDriftSnapshots.headersJson,
  capturedAt: seoDriftSnapshots.capturedAt,
};

async function getSnapshotsForUrl(input: {
  projectId: string;
  url: string;
  limit: number;
}) {
  return db
    .select({ ...snapshotColumns, baselineName: seoDriftBaselines.name })
    .from(seoDriftSnapshots)
    .innerJoin(
      seoDriftBaselines,
      eq(seoDriftSnapshots.baselineId, seoDriftBaselines.id),
    )
    .where(
      and(
        eq(seoDriftBaselines.projectId, input.projectId),
        eq(seoDriftSnapshots.url, input.url),
      ),
    )
    .orderBy(desc(seoDriftSnapshots.capturedAt), desc(seoDriftSnapshots.id))
    .limit(input.limit);
}

async function getOpenChanges(baselineId: string) {
  return db
    .select({
      id: seoDriftChanges.id,
      url: seoDriftChanges.url,
      field: seoDriftChanges.field,
      oldValue: seoDriftChanges.oldValue,
      newValue: seoDriftChanges.newValue,
      changeType: seoDriftChanges.changeType,
    })
    .from(seoDriftChanges)
    .where(
      and(
        eq(seoDriftChanges.baselineId, baselineId),
        isNull(seoDriftChanges.resolvedAt),
      ),
    )
    .orderBy(seoDriftChanges.url, seoDriftChanges.field);
}

async function insertChanges(changes: ChangeInsert[]) {
  await executeInBatches(changes, (tx, change) =>
    tx.insert(seoDriftChanges).values(change),
  );
}

async function resolveChanges(ids: string[], resolvedAt: string) {
  if (ids.length === 0) return;
  // Chunked so each IN list stays under D1's ~100 bound-parameter ceiling.
  const batchSize = 90;
  for (let i = 0; i < ids.length; i += batchSize) {
    const chunk = ids.slice(i, i + batchSize);
    await db
      .update(seoDriftChanges)
      .set({ resolvedAt })
      .where(inArray(seoDriftChanges.id, chunk));
  }
}

const changeColumns = {
  id: seoDriftChanges.id,
  baselineId: seoDriftChanges.baselineId,
  url: seoDriftChanges.url,
  field: seoDriftChanges.field,
  oldValue: seoDriftChanges.oldValue,
  newValue: seoDriftChanges.newValue,
  changeType: seoDriftChanges.changeType,
  severity: seoDriftChanges.severity,
  detectedAt: seoDriftChanges.detectedAt,
  resolvedAt: seoDriftChanges.resolvedAt,
};

async function getChangesForUrl(input: {
  projectId: string;
  url: string;
  limit: number;
}) {
  return db
    .select(changeColumns)
    .from(seoDriftChanges)
    .innerJoin(
      seoDriftBaselines,
      eq(seoDriftChanges.baselineId, seoDriftBaselines.id),
    )
    .where(
      and(
        eq(seoDriftBaselines.projectId, input.projectId),
        eq(seoDriftChanges.url, input.url),
      ),
    )
    .orderBy(desc(seoDriftChanges.detectedAt), desc(seoDriftChanges.id))
    .limit(input.limit);
}

async function getChangesForBaseline(input: {
  projectId: string;
  baselineId: string;
  limit: number;
}) {
  return db
    .select(changeColumns)
    .from(seoDriftChanges)
    .innerJoin(
      seoDriftBaselines,
      eq(seoDriftChanges.baselineId, seoDriftBaselines.id),
    )
    .where(
      and(
        eq(seoDriftBaselines.projectId, input.projectId),
        eq(seoDriftChanges.baselineId, input.baselineId),
      ),
    )
    .orderBy(desc(seoDriftChanges.detectedAt), desc(seoDriftChanges.id))
    .limit(input.limit);
}

async function listBaselines(input: { projectId: string }) {
  return db
    .select()
    .from(seoDriftBaselines)
    .where(eq(seoDriftBaselines.projectId, input.projectId))
    .orderBy(desc(seoDriftBaselines.createdAt));
}

/**
 * Baselines due for the scheduled comparison: never compared, or last
 * compared before the cutoff. ISO-text timestamps sort lexicographically on
 * both dialects, so a plain `<` is correct. Capped per tick.
 */
async function getDueBaselines(input: { cutoffIso: string; limit: number }) {
  return db
    .select()
    .from(seoDriftBaselines)
    .where(
      or(
        isNull(seoDriftBaselines.lastComparedAt),
        lt(seoDriftBaselines.lastComparedAt, input.cutoffIso),
      ),
    )
    .limit(input.limit);
}

async function touchBaselineCompared(input: {
  baselineId: string;
  comparedAt: string;
}) {
  await db
    .update(seoDriftBaselines)
    .set({ lastComparedAt: input.comparedAt })
    .where(eq(seoDriftBaselines.id, input.baselineId));
}

export const DriftRepository = {
  createBaseline,
  listBaselines,
  getDueBaselines,
  touchBaselineCompared,
  getBaseline,
  insertSnapshots,
  getSnapshotsForBaseline,
  getSnapshotsForUrl,
  getOpenChanges,
  insertChanges,
  resolveChanges,
  getChangesForUrl,
  getChangesForBaseline,
};
