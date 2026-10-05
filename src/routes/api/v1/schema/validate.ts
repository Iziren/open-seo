import { createFileRoute } from "@tanstack/react-router";
import { machinePost } from "@/server/api/machine-route";
import { SchemaService } from "@/server/features/audit/services/SchemaService";
import { validateSchemaInputSchema } from "@/types/schemas/audit";

export const Route = createFileRoute("/api/v1/schema/validate")({
  server: {
    handlers: {
      POST: ({ request }: { request: Request }) =>
        machinePost(request, validateSchemaInputSchema, (auth, input) =>
          Promise.resolve(
            SchemaService.validate({
              projectId: auth.projectId,
              document: input.document,
            }),
          ),
        ),
    },
  },
});
