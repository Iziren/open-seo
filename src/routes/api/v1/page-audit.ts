import { createFileRoute } from "@tanstack/react-router";
import { machinePost } from "@/server/api/machine-route";
import { PageAuditService } from "@/server/features/audit/services/PageAuditService";
import { auditPageSchema } from "@/types/schemas/audit";

export const Route = createFileRoute("/api/v1/page-audit")({
  server: {
    handlers: {
      POST: ({ request }: { request: Request }) =>
        machinePost(request, auditPageSchema, (auth, input) =>
          PageAuditService.auditPage({
            projectId: auth.projectId,
            url: input.url,
          }),
        ),
    },
  },
});
