import { z } from "zod";
import { DriftService } from "@/server/features/drift/services/DriftService";
import { mcpResponse } from "@/server/mcp/formatters";
import { buildProjectMeta } from "@/server/mcp/context";
import { optionalMetaOutputSchema } from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";

const urlsSchema = z
  .array(z.string().min(1).max(2048))
  .min(1)
  .max(100)
  .describe("Page URLs to snapshot (1-100).");

// ─── capture_drift_baseline ──────────────────────────────────────────────────

const captureInputSchema = {
  projectId: projectIdSchema,
  urls: urlsSchema,
  name: z
    .string()
    .min(1)
    .max(120)
    .optional()
    .describe("Baseline name. Defaults to the capture date."),
} as const;

type CaptureArgs = z.infer<z.ZodObject<typeof captureInputSchema>>;

export const captureDriftBaselineTool = {
  name: "capture_drift_baseline",
  config: {
    title: "Capture an SEO drift baseline",
    description:
      "Snapshot the SEO attributes (title, meta, canonical, H1, schema, " +
      "status, indexability) of up to 100 URLs as a named baseline for later " +
      "comparison. Uses no credits — plain fetches. Blocked for " +
      "private/internal targets.",
    inputSchema: captureInputSchema,
    outputSchema: z.looseObject({
      baselineId: z.string(),
      name: z.string(),
      captured: z.number(),
      failures: z.number(),
      ...optionalMetaOutputSchema,
    }),
    annotations: {
      readOnlyHint: false,
      openWorldHint: true,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: CaptureArgs, context) => {
    const result = await DriftService.captureBaseline({
      projectId: args.projectId,
      urls: args.urls,
      name: args.name,
    });

    return mcpResponse({
      text:
        `Captured drift baseline "${result.baseline.name}" (${result.baseline.id}): ` +
        `${result.snapshots.length} page(s) snapshotted` +
        (result.failures.length > 0
          ? `, ${result.failures.length} failed`
          : "") +
        ". Compare later with compare_drift.",
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/drift`,
      ),
      structuredContent: {
        baselineId: result.baseline.id,
        name: result.baseline.name,
        captured: result.snapshots.length,
        failures: result.failures.length,
      },
    });
  }),
};

// ─── compare_drift ───────────────────────────────────────────────────────────

const compareInputSchema = {
  projectId: projectIdSchema,
  baselineId: z.string().min(1).describe("Baseline ID to re-check."),
} as const;

type CompareArgs = z.infer<z.ZodObject<typeof compareInputSchema>>;

export const compareDriftBaselineTool = {
  name: "compare_drift",
  config: {
    title: "Compare against a drift baseline",
    description:
      "Re-fetch every URL in a baseline and diff against the stored " +
      "snapshot: title/meta/canonical/schema/status/indexability changes " +
      "with severity. Resolved changes close automatically. Uses no credits.",
    inputSchema: compareInputSchema,
    outputSchema: z.looseObject({
      baselineId: z.string(),
      compared: z.number(),
      inserted: z.number(),
      resolved: z.number(),
      failures: z.number(),
      ...optionalMetaOutputSchema,
    }),
    annotations: {
      readOnlyHint: false,
      openWorldHint: true,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: CompareArgs, context) => {
    const result = await DriftService.compareBaseline({
      projectId: args.projectId,
      baselineId: args.baselineId,
    });

    return mcpResponse({
      text:
        `Compared baseline ${result.baselineId}: ${result.compared} page(s), ` +
        `${result.inserted} new change(s), ${result.resolved} resolved` +
        (result.failures.length > 0
          ? `, ${result.failures.length} fetch failure(s)`
          : "") +
        ".",
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/drift`,
      ),
      structuredContent: {
        baselineId: result.baselineId,
        compared: result.compared,
        inserted: result.inserted,
        resolved: result.resolved,
        failures: result.failures.length,
      },
    });
  }),
};

// ─── get_drift_changes ───────────────────────────────────────────────────────

const changesInputSchema = {
  projectId: projectIdSchema,
  baselineId: z.string().min(1).describe("Baseline ID to read changes for."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe("Max changes to return (default 20)."),
} as const;

type ChangesArgs = z.infer<z.ZodObject<typeof changesInputSchema>>;

export const getDriftChangesTool = {
  name: "get_drift_changes",
  config: {
    title: "Read drift changes",
    description:
      "List detected SEO changes for a baseline: field, old and new value, " +
      "severity, and whether each change is still open. Uses no credits.",
    inputSchema: changesInputSchema,
    outputSchema: z.looseObject({
      baselineId: z.string(),
      changeCount: z.number(),
      changes: z.array(
        z.looseObject({
          url: z.string(),
          field: z.string(),
          severity: z.string(),
        }),
      ),
      ...optionalMetaOutputSchema,
    }),
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: ChangesArgs, context) => {
    const changes = await DriftService.getChanges({
      projectId: args.projectId,
      baselineId: args.baselineId,
      limit: args.limit,
    });

    const open = changes.filter((c) => c.resolvedAt == null);
    return mcpResponse({
      text:
        `Baseline ${args.baselineId}: ${changes.length} change(s), ` +
        `${open.length} still open.`,
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/drift`,
      ),
      structuredContent: {
        baselineId: args.baselineId,
        changeCount: changes.length,
        changes: changes.map((change) => ({
          url: change.url,
          field: change.field,
          severity: change.severity,
          oldValue: change.oldValue,
          newValue: change.newValue,
          resolvedAt: change.resolvedAt,
        })),
      },
    });
  }),
};
