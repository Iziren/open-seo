import { createFileRoute } from "@tanstack/react-router";
import { machineGet } from "@/server/api/machine-route";
import { DriftService } from "@/server/features/drift/services/DriftService";
import { AppError } from "@/server/lib/errors";

export const Route = createFileRoute("/api/v1/drift/changes")({
  server: {
    handlers: {
      GET: ({ request }: { request: Request }) =>
        machineGet(request, (auth, url) => {
          const baselineId = url.searchParams.get("baselineId");
          if (!baselineId) {
            throw new AppError("VALIDATION_ERROR", "baselineId is required");
          }
          const limitRaw = url.searchParams.get("limit");
          const limit = limitRaw === null ? undefined : Number(limitRaw);
          return DriftService.getChanges({
            projectId: auth.projectId,
            baselineId,
            limit:
              limit !== undefined && Number.isInteger(limit)
                ? limit
                : undefined,
          });
        }),
    },
  },
});
