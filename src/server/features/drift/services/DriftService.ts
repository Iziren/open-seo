import { AppError } from "@/server/lib/errors";
import {
  isCrawlableUrl,
  normalizeAndValidateStartUrl,
} from "@/server/lib/audit/url-policy";
import { normalizeUrl } from "@/server/lib/audit/url-utils";
import { DriftRepository } from "../repositories/DriftRepository";
import { diffSnapshots, reconcileChanges } from "../driftCompare";
import { fetchDriftPage } from "./driftFetch";
import type { DriftAttributes, DriftDiff } from "../types";

const DEFAULT_HISTORY_LIMIT = 20;
const MAX_HISTORY_LIMIT = 200;

// Scheduled comparison cadence + per-tick cap. Comparisons are free (plain
// fetches, no DataForSEO), so the cap bounds tick duration, not spend.
const SCHEDULED_COMPARE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const SCHEDULED_COMPARE_LIMIT = 5;

/**
 * Capture the SEO attributes of every URL and store them as a new baseline
 * (drift_baseline.py port). URLs are validated up front — one rejected URL
 * fails the whole call before anything is fetched or written — and fetch
 * failures are reported per URL instead: a site that is down for one page
 * must not discard the pages that did capture.
 */
async function captureBaseline(input: {
  projectId: string;
  urls: string[];
  name?: string;
}) {
  if (input.urls.length === 0) {
    throw new AppError("VALIDATION_ERROR", "Provide at least one URL");
  }
  const urls = await normalizeDriftUrls(input.urls);

  const baselineId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const name = input.name?.trim() || defaultBaselineName(createdAt);
  await DriftRepository.createBaseline({
    id: baselineId,
    projectId: input.projectId,
    name,
    createdAt,
  });

  const captured: DriftAttributes[] = [];
  const failures: Array<{ url: string; error: string }> = [];
  for (const url of urls) {
    try {
      captured.push(await captureAttributes(url));
    } catch (error) {
      failures.push({ url, error: errorMessage(error) });
    }
  }

  const capturedAt = new Date().toISOString();
  await DriftRepository.insertSnapshots(
    captured.map((attributes) => ({
      id: crypto.randomUUID(),
      baselineId,
      capturedAt,
      ...attributes,
    })),
  );

  return {
    baseline: {
      id: baselineId,
      projectId: input.projectId,
      name,
      createdAt,
    },
    snapshots: captured,
    failures,
  };
}

/**
 * Re-fetch every snapshot in a baseline, diff against the stored state, and
 * reconcile the change rows (drift_compare.py port): new diffs insert, diffs
 * that vanished resolve, stable diffs keep their first-seen timestamp.
 * A URL whose fetch fails contributes no diffs AND resolves nothing — its
 * open changes stay open because the current state is unknown.
 */
async function compareBaseline(input: {
  projectId: string;
  baselineId: string;
}) {
  const baseline = await DriftRepository.getBaseline(input);
  if (!baseline) {
    throw new AppError("NOT_FOUND", "Drift baseline not found");
  }

  const [snapshots, openChanges] = await Promise.all([
    DriftRepository.getSnapshotsForBaseline(baseline.id),
    DriftRepository.getOpenChanges(baseline.id),
  ]);

  const diffs: DriftDiff[] = [];
  const failures: Array<{ url: string; error: string }> = [];
  const comparedUrls: string[] = [];
  for (const snapshot of snapshots) {
    try {
      const current = await captureAttributes(snapshot.url);
      diffs.push(...diffSnapshots(snapshot, current));
      comparedUrls.push(snapshot.url);
    } catch (error) {
      failures.push({ url: snapshot.url, error: errorMessage(error) });
    }
  }

  const { inserts, resolveIds, keptIds } = reconcileChanges({
    openChanges,
    diffs,
    comparedUrls: new Set(comparedUrls),
  });

  const now = new Date().toISOString();
  const rows = inserts.map((diff) => ({
    id: crypto.randomUUID(),
    baselineId: baseline.id,
    url: diff.url,
    field: diff.field,
    oldValue: diff.oldValue,
    newValue: diff.newValue,
    changeType: diff.changeType,
    severity: diff.severity,
    detectedAt: now,
    resolvedAt: null,
  }));
  await DriftRepository.insertChanges(rows);
  await DriftRepository.resolveChanges(resolveIds, now);
  await DriftRepository.touchBaselineCompared({
    baselineId: baseline.id,
    comparedAt: now,
  });

  return {
    baselineId: baseline.id,
    compared: comparedUrls.length,
    failures,
    inserted: rows.length,
    resolved: resolveIds.length,
    kept: keptIds.length,
    severityCounts: countSeverities(diffs),
  };
}

/**
 * Baseline snapshots + change history for one URL within the project
 * (drift_history.py port, limited to what the schema keeps: snapshots and
 * changes — the Python script's per-comparison summaries are derived from
 * the change rows instead).
 */
async function getHistory(input: {
  projectId: string;
  url: string;
  limit?: number;
}) {
  const url = normalizeUrl(input.url);
  if (!url) {
    throw new AppError("VALIDATION_ERROR", `Invalid URL: ${input.url}`);
  }
  const limit = clampLimit(input.limit);
  const [snapshots, changes] = await Promise.all([
    DriftRepository.getSnapshotsForUrl({
      projectId: input.projectId,
      url,
      limit,
    }),
    DriftRepository.getChangesForUrl({
      projectId: input.projectId,
      url,
      limit,
    }),
  ]);
  return { url, snapshots, changes };
}

async function getChanges(input: {
  projectId: string;
  baselineId: string;
  limit?: number;
}) {
  const baseline = await DriftRepository.getBaseline({
    baselineId: input.baselineId,
    projectId: input.projectId,
  });
  if (!baseline) {
    throw new AppError("NOT_FOUND", "Drift baseline not found");
  }
  return DriftRepository.getChangesForBaseline({
    projectId: input.projectId,
    baselineId: baseline.id,
    limit: clampLimit(input.limit),
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Validate + normalize every input URL, deduplicating by the normalized form
 * that gets stored as seo_drift_snapshots.url — history lookups normalize the
 * same way, so capture and query always agree on a URL's identity.
 */
async function normalizeDriftUrls(rawUrls: string[]): Promise<string[]> {
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const raw of rawUrls) {
    const trimmed = raw.trim();
    if (!trimmed) {
      throw new AppError("VALIDATION_ERROR", "URLs must not be empty");
    }
    const candidate = /^https?:\/\//i.test(trimmed)
      ? trimmed
      : `https://${trimmed}`;
    // Synchronous gate first: rejects blocked hosts and non-http schemes
    // before any DNS lookup; normalizeAndValidateStartUrl then adds the DoH
    // private-address check for hostnames.
    if (!isCrawlableUrl(candidate)) {
      throw new AppError(
        "CRAWL_TARGET_BLOCKED",
        "URL rejected: only public http/https URLs are accepted (SSRF protection)",
      );
    }
    const validated = await normalizeAndValidateStartUrl(candidate);
    const normalized = normalizeUrl(validated);
    if (!normalized) {
      throw new AppError("VALIDATION_ERROR", `Invalid URL: ${trimmed}`);
    }
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    urls.push(normalized);
  }
  return urls;
}

async function captureAttributes(url: string): Promise<DriftAttributes> {
  const page = await fetchDriftPage(url);
  // Dynamic imports keep htmlparser2 out of the static worker module graph
  // (same reasoning as crawlPage's parser import): only an actual capture
  // pays for loading it.
  const [{ analyzeHtml }, { extractJsonLdBlocks }] = await Promise.all([
    import("@/server/lib/audit/page-analyzer"),
    import("../driftJsonLd"),
  ]);
  const analysis = analyzeHtml(
    page.html,
    page.finalUrl,
    page.statusCode,
    page.responseTimeMs,
  );
  const xRobotsTag = page.headers["x-robots-tag"] ?? null;
  // Same indexability rule as the audit crawl: noindex in the meta tag OR the
  // X-Robots-Tag header makes the page non-indexable.
  const robotsDirectives = [analysis.robotsMeta, xRobotsTag]
    .filter((value): value is string => Boolean(value))
    .join(",")
    .toLowerCase();

  return {
    url,
    canonicalUrl: analysis.canonical
      ? (normalizeUrl(analysis.canonical, page.finalUrl) ?? analysis.canonical)
      : null,
    title: analysis.title || null,
    metaDescription: analysis.metaDescription || null,
    h1: analysis.h1s.find((heading) => heading.length > 0) ?? null,
    schemaJsonLd: JSON.stringify(extractJsonLdBlocks(page.html)),
    robotsMeta: analysis.robotsMeta || null,
    statusCode: page.statusCode,
    indexable: !robotsDirectives.includes("noindex"),
    wordCount: analysis.wordCount,
    externalLinkCount: analysis.links.filter((link) => !link.isInternal).length,
    headersJson: JSON.stringify(page.headers),
  };
}

function defaultBaselineName(createdAt: string): string {
  // "Baseline 2026-09-28 14:03" — readable next to the exact created_at row.
  return `Baseline ${createdAt.slice(0, 16).replace("T", " ")}`;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_HISTORY_LIMIT;
  return Math.min(Math.max(Math.floor(limit), 1), MAX_HISTORY_LIMIT);
}

function countSeverities(diffs: DriftDiff[]) {
  const counts = { critical: 0, warning: 0, info: 0 };
  for (const diff of diffs) counts[diff.severity] += 1;
  return counts;
}

function errorMessage(error: unknown): string {
  if (error instanceof AppError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return String(error);
}

export const DriftService = {
  captureBaseline,
  compareBaseline,
  getHistory,
  getChanges,
  listBaselines,
  runScheduledComparisons,
} as const;

async function listBaselines(input: { projectId: string }) {
  return DriftRepository.listBaselines({ projectId: input.projectId });
}

/**
 * Cron body for the `scheduled` Worker handler: compare every baseline due
 * for its weekly run. Per-baseline try/catch — one dead site must not skip
 * the rest of the tick. Overdue baselines stay due and resume next tick.
 */
async function runScheduledComparisons(): Promise<{
  compared: number;
  failed: number;
}> {
  const cutoffIso = new Date(
    Date.now() - SCHEDULED_COMPARE_INTERVAL_MS,
  ).toISOString();
  const due = await DriftRepository.getDueBaselines({
    cutoffIso,
    limit: SCHEDULED_COMPARE_LIMIT,
  });

  let compared = 0;
  let failed = 0;
  for (const baseline of due) {
    try {
      await compareBaseline({
        projectId: baseline.projectId,
        baselineId: baseline.id,
      });
      compared += 1;
    } catch (error) {
      failed += 1;
      console.error(
        `[cron] drift compare failed for baseline ${baseline.id}:`,
        error,
      );
    }
  }
  return { compared, failed };
}
