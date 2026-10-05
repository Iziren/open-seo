import { z } from "zod";
import { SchemaService } from "@/server/features/audit/services/SchemaService";
import { mcpResponse } from "@/server/mcp/formatters";
import { buildProjectMeta } from "@/server/mcp/context";
import { optionalMetaOutputSchema } from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";

const inputSchema = {
  projectId: projectIdSchema,
  type: z
    .enum(["Product", "Organization", "Website", "BreadcrumbList", "FAQPage"])
    .describe("Schema.org type to generate."),
  data: z
    .looseObject({})
    .describe(
      "Type fields as a JSON object. Product: name (required), description, " +
        "image[], sku, brand, url, offers {price, priceCurrency, availability, " +
        "url}, aggregateRating {ratingValue, reviewCount} — ratings only from " +
        "real data, never invented. Organization: name, url, logo, sameAs[]. " +
        "Website: name, url, searchUrlTemplate?. BreadcrumbList: pageUrl, " +
        "siteName?. FAQPage: mainEntity [{question, answer}], url?.",
    ),
} as const;

type Args = z.infer<z.ZodObject<typeof inputSchema>>;

export const generateSchemaTool = {
  name: "generate_schema",
  config: {
    title: "Generate schema.org JSON-LD",
    description:
      "Generate valid schema.org JSON-LD for Product, Organization, " +
      "Website, BreadcrumbList, or FAQPage. The output is self-checked " +
      "against the validator before it is returned. Uses no credits. " +
      "Aggregate ratings are emitted only from supplied real data.",
    inputSchema,
    outputSchema: z.looseObject({
      type: z.string(),
      document: z.looseObject({}),
      script: z.string(),
      valid: z.boolean(),
      ...optionalMetaOutputSchema,
    }),
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: Args, context) => {
    const result = await SchemaService.generate({
      projectId: args.projectId,
      type: args.type,
      data: args.data,
    });

    return mcpResponse({
      text:
        `Generated ${result.type} JSON-LD` +
        (result.validation.ok
          ? " — validates clean."
          : ` — with ${result.validation.errors.length} error(s): ` +
            result.validation.errors
              .slice(0, 3)
              .map((e) => e.code)
              .join(", ") +
            "."),
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/page-audit`,
      ),
      structuredContent: {
        type: result.type,
        document: result.document,
        script: result.script,
        valid: result.validation.ok,
      },
    });
  }),
};
