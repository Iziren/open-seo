import { createFileRoute } from "@tanstack/react-router";
import { machinePost } from "@/server/api/machine-route";
import { DriftService } from "@/server/features/drift/services/DriftService";
import { compareDriftBaselineSchema } from "@/types/schemas/drift";

export const Route = createFileRoute("/api/v1/drift/compare")({
  server: {
    handlers: {
      POST: ({ request }: { request: Request }) =>
        machinePost(request, compareDriftBaselineSchema, (auth, input) =>
          DriftService.compareBaseline({
            projectId: auth.projectId,
            baselineId: input.baselineId,
          }),
        ),
    },
  },
});
