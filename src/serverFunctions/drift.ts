import { createServerFn } from "@tanstack/react-start";
import { waitUntil } from "cloudflare:workers";
import { DriftService } from "@/server/features/drift/services/DriftService";
import { captureServerEvent } from "@/server/lib/posthog";
import { requireProjectContext } from "@/serverFunctions/middleware";
import {
  captureDriftBaselineSchema,
  compareDriftBaselineSchema,
  getDriftChangesSchema,
  getDriftHistorySchema,
  listDriftBaselinesSchema,
} from "@/types/schemas/drift";

export const captureDriftBaseline = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(captureDriftBaselineSchema)
  .handler(async ({ data, context }) => {
    const result = await DriftService.captureBaseline({
      projectId: context.projectId,
      urls: data.urls,
      name: data.name,
    });

    waitUntil(
      captureServerEvent({
        distinctId: context.userId,
        event: "drift:capture",
        organizationId: context.organizationId,
        properties: {
          project_id: context.projectId,
          urls: data.urls.length,
          failures: result.failures.length,
        },
      }),
    );

    return result;
  });

export const compareDriftBaseline = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(compareDriftBaselineSchema)
  .handler(async ({ data, context }) => {
    const result = await DriftService.compareBaseline({
      projectId: context.projectId,
      baselineId: data.baselineId,
    });

    waitUntil(
      captureServerEvent({
        distinctId: context.userId,
        event: "drift:compare",
        organizationId: context.organizationId,
        properties: {
          project_id: context.projectId,
          compared: result.compared,
          inserted: result.inserted,
        },
      }),
    );

    return result;
  });

export const getDriftChanges = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(getDriftChangesSchema)
  .handler(async ({ data, context }) => {
    return DriftService.getChanges({
      projectId: context.projectId,
      baselineId: data.baselineId,
      limit: data.limit,
    });
  });

export const getDriftHistory = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(getDriftHistorySchema)
  .handler(async ({ data, context }) => {
    return DriftService.getHistory({
      projectId: context.projectId,
      url: data.url,
      limit: data.limit,
    });
  });

export const listDriftBaselines = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(listDriftBaselinesSchema)
  .handler(async ({ context }) => {
    return DriftService.listBaselines({ projectId: context.projectId });
  });
