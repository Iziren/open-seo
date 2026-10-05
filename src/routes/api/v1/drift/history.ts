import { createFileRoute } from "@tanstack/react-router";
import { machineGet } from "@/server/api/machine-route";
import { DriftService } from "@/server/features/drift/services/DriftService";
import { AppError } from "@/server/lib/errors";

export const Route = createFileRoute("/api/v1/drift/history")({
  server: {
    handlers: {
      GET: ({ request }: { request: Request }) =>
        machineGet(request, (auth, url) => {
          const target = url.searchParams.get("url");
          if (!target) {
            throw new AppError("VALIDATION_ERROR", "url is required");
          }
          const limitRaw = url.searchParams.get("limit");
          const limit = limitRaw === null ? undefined : Number(limitRaw);
          return DriftService.getHistory({
            projectId: auth.projectId,
            url: target,
            limit:
              limit !== undefined && Number.isInteger(limit)
                ? limit
                : undefined,
          });
        }),
    },
  },
});
