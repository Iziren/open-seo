import { createFileRoute } from "@tanstack/react-router";
import { machinePost } from "@/server/api/machine-route";
import { SchemaService } from "@/server/features/audit/services/SchemaService";
import { generateSchemaInputSchema } from "@/types/schemas/audit";

export const Route = createFileRoute("/api/v1/schema/generate")({
  server: {
    handlers: {
      POST: ({ request }: { request: Request }) =>
        machinePost(request, generateSchemaInputSchema, (auth, input) =>
          SchemaService.generate({
            projectId: auth.projectId,
            type: input.type,
            data: input.data,
          }),
        ),
    },
  },
});
