import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { machineOrgPost } from "@/server/api/machine-route";
import { ProjectService } from "@/server/features/projects/services/ProjectService";

const ensureProjectSchema = z.object({
  domain: z
    .string()
    .min(1, "Store domain is required.")
    .max(253)
    .describe("Storefront domain, e.g. shop.example.com."),
  name: z
    .string()
    .min(1)
    .max(120)
    .optional()
    .describe("Project display name. Defaults to the domain."),
  locationCode: z
    .number()
    .int()
    .optional()
    .describe("DataForSEO location code for the store's market."),
  languageCode: z
    .string()
    .optional()
    .describe("Language code for the store's market (needs locationCode)."),
});

/** Normalize a storefront origin to a bare host for project matching. */
function normalizeDomain(input: string): string {
  const trimmed = input.trim().toLowerCase();
  const withoutProtocol = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  const host = withoutProtocol.split("/")[0].split("?")[0].split("#")[0];
  return host.replace(/^www\./, "");
}

export const Route = createFileRoute("/api/v1/projects/ensure")({
  server: {
    handlers: {
      POST: ({ request }: { request: Request }) =>
        machineOrgPost(request, ensureProjectSchema, async (auth, input) => {
          const domain = normalizeDomain(input.domain);
          const existing = await ProjectService.listProjects(
            auth.organizationId,
          );
          const match = existing.find(
            (project) =>
              project.domain !== null &&
              normalizeDomain(project.domain) === domain,
          );
          if (match) return { project: match, created: false };

          const project = await ProjectService.createProject(
            auth.organizationId,
            {
              name: input.name ?? domain,
              domain,
              locationCode: input.locationCode,
              languageCode: input.languageCode,
            },
          );
          return { project, created: true };
        }),
    },
  },
});
