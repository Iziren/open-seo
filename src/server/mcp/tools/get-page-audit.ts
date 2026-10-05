import { z } from "zod";
import { PageAuditService } from "@/server/features/audit/services/PageAuditService";
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
      "Single page URL to audit (product page, article, landing page). " +
        "The page is fetched and analyzed on demand: on-page signals, " +
        "content quality, structured data, and AI-search citability.",
    ),
} as const;

type Args = z.infer<z.ZodObject<typeof inputSchema>>;

const pageAuditOutputSchema = z.looseObject({
  url: z.string(),
  finalUrl: z.string(),
  statusCode: z.number(),
  title: z.string(),
  wordCount: z.number(),
  contentScore: z.number().nullable(),
  schemaStatus: z.enum(["missing", "valid", "invalid"]),
  schemaTypes: z.array(z.string()),
  geoScore: z.number(),
  spaShell: z.boolean(),
  issueCount: z.number(),
});

export const getPageAuditTool = {
  name: "get_page_audit",
  config: {
    title: "Audit a single page",
    description:
      "Audit one URL on demand and return its report card: title/meta, " +
      "content-quality score, structured-data verdict, AI-citability score, " +
      "and the same issue types a full site audit reports. Uses no credits — " +
      "no DataForSEO calls. Blocked for private/internal targets.",
    inputSchema,
    outputSchema: z.looseObject({
      page: pageAuditOutputSchema,
      issues: z.array(
        z.looseObject({
          issueType: z.string(),
          pageUrl: z.string(),
        }),
      ),
      ...optionalMetaOutputSchema,
    }),
    annotations: {
      readOnlyHint: true,
      openWorldHint: true,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: Args, context) => {
    const result = await PageAuditService.auditPage({
      projectId: args.projectId,
      url: args.url,
    });

    const topIssues = result.issues.slice(0, 3).map((i) => i.issueType);
    return mcpResponse({
      text:
        `Page audit for ${result.finalUrl}: content ${result.contentScore ?? "n/a"}/100, ` +
        `schema ${result.schemaStatus}, AI citability ${result.geoScore}/100, ` +
        `${result.issues.length} issue(s)` +
        (topIssues.length > 0 ? ` (top: ${topIssues.join(", ")})` : "") +
        ".",
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/page-audit`,
      ),
      structuredContent: {
        page: {
          url: result.url,
          finalUrl: result.finalUrl,
          statusCode: result.statusCode,
          title: result.title,
          wordCount: result.wordCount,
          contentScore: result.contentScore,
          schemaStatus: result.schemaStatus,
          schemaTypes: result.schemaTypes,
          geoScore: result.geoScore,
          spaShell: result.spaShell,
          issueCount: result.issues.length,
        },
        issues: result.issues.map((issue) => ({
          issueType: issue.issueType,
          pageUrl: issue.pageUrl,
          details: issue.details ?? {},
        })),
      },
    });
  }),
};
