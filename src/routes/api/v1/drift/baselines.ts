import { createFileRoute } from "@tanstack/react-router";
import { machineGet, machinePost } from "@/server/api/machine-route";
import { DriftService } from "@/server/features/drift/services/DriftService";
import { captureDriftBaselineSchema } from "@/types/schemas/drift";

export const Route = createFileRoute("/api/v1/drift/baselines")({
  server: {
    handlers: {
      GET: ({ request }: { request: Request }) =>
        machineGet(request, (auth) =>
          DriftService.listBaselines({ projectId: auth.projectId }),
        ),
      POST: ({ request }: { request: Request }) =>
        machinePost(request, captureDriftBaselineSchema, (auth, input) =>
          DriftService.captureBaseline({
            projectId: auth.projectId,
            urls: input.urls,
            name: input.name,
          }),
        ),
    },
  },
});
