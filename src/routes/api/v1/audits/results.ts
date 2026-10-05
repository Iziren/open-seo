import { createFileRoute } from "@tanstack/react-router";
import { machineGet } from "@/server/api/machine-route";
import { AuditService } from "@/server/features/audit/services/AuditService";
import { AppError } from "@/server/lib/errors";

export const Route = createFileRoute("/api/v1/audits/results")({
  server: {
    handlers: {
      GET: ({ request }: { request: Request }) =>
        machineGet(request, (auth, url) => {
          const auditId = url.searchParams.get("auditId");
          if (!auditId) {
            throw new AppError("VALIDATION_ERROR", "auditId is required");
          }
          return AuditService.getResults(auditId, auth.projectId);
        }),
    },
  },
});
