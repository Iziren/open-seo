import { z } from "zod";

export const captureDriftBaselineSchema = z.object({
  projectId: z.string().min(1),
  urls: z
    .array(z.string().min(1).max(2048))
    .min(1, "Provide at least one URL.")
    .max(100, "At most 100 URLs per baseline."),
  name: z.string().min(1).max(120).optional(),
});

export const compareDriftBaselineSchema = z.object({
  projectId: z.string().min(1),
  baselineId: z.string().min(1),
});

export const getDriftChangesSchema = z.object({
  projectId: z.string().min(1),
  baselineId: z.string().min(1),
  limit: z.number().int().min(1).max(200).optional(),
});

export const getDriftHistorySchema = z.object({
  projectId: z.string().min(1),
  url: z.string().min(1, "URL is required").max(2048),
  limit: z.number().int().min(1).max(200).optional(),
});

export const listDriftBaselinesSchema = z.object({
  projectId: z.string().min(1),
});

// ─── URL search params schema for /p/$projectId/drift ────────────────────────

export const driftSearchSchema = z.object({
  baselineId: z.string().optional().catch(undefined),
  url: z.string().optional().catch(undefined),
});
