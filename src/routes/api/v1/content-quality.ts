import { createFileRoute } from "@tanstack/react-router";
import { machinePost } from "@/server/api/machine-route";
import { ContentQualityService } from "@/server/features/audit/services/ContentQualityService";
import { gradeContentSchema } from "@/types/schemas/audit";

export const Route = createFileRoute("/api/v1/content-quality")({
  server: {
    handlers: {
      POST: ({ request }: { request: Request }) =>
        machinePost(request, gradeContentSchema, (auth, input) =>
          ContentQualityService.gradeUrl({
            projectId: auth.projectId,
            url: input.url,
          }),
        ),
    },
  },
});
