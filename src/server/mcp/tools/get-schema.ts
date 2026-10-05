import { z } from "zod";
import { SchemaService } from "@/server/features/audit/services/SchemaService";
import { mcpResponse } from "@/server/mcp/formatters";
import { buildProjectMeta } from "@/server/mcp/context";
import { optionalMetaOutputSchema } from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";

const inputSchema = {
  projectId: projectIdSchema,
  url: z
    .string()
    .min(1, "URL is required.")
    .max(2048)
    .describe(
      "Page URL to read structured data from. All JSON-LD blocks are " +
        "extracted and validated: e-commerce rules (price, availability, " +
        "images, identifiers), deprecated types, orphan offers, and " +
        "duplicate or conflicting Product blocks.",
    ),
} as const;

type Args = z.infer<z.ZodObject<typeof inputSchema>>;

export const getSchemaTool = {
  name: "get_schema",
  config: {
    title: "Read and validate page schema",
    description:
      "Fetch a URL, extract every JSON-LD block, and validate the combined " +
      "document: required fields, e-commerce rules, deprecated types, and " +
      "conflicts. Uses no credits. Blocked for private/internal targets.",
    inputSchema,
    outputSchema: z.looseObject({
      url: z.string(),
      finalUrl: z.string(),
      types: z.array(z.string()),
      scriptCount: z.number(),
      valid: z.boolean(),
      errorCount: z.number(),
      warningCount: z.number(),
      ...optionalMetaOutputSchema,
    }),
    annotations: {
      readOnlyHint: true,
      openWorldHint: true,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: Args, context) => {
    const result = await SchemaService.extractFromUrl({
      projectId: args.projectId,
      url: args.url,
    });

    const topErrors = result.validation.errors.slice(0, 3).map((e) => e.code);
    return mcpResponse({
      text:
        `Schema on ${result.finalUrl}: ${result.scriptCount} script(s), ` +
        `types [${result.types.join(", ") || "none"}]` +
        (result.validation.ok
          ? " — validates clean."
          : ` — ${result.validation.errors.length} error(s)` +
            (topErrors.length > 0 ? `: ${topErrors.join(", ")}` : "") +
            "."),
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/page-audit`,
      ),
      structuredContent: {
        url: result.url,
        finalUrl: result.finalUrl,
        types: result.types,
        scriptCount: result.scriptCount,
        valid: result.validation.ok,
        errorCount: result.validation.errors.length,
        warningCount: result.validation.warnings.length,
      },
    });
  }),
};
