import { z } from "zod";
import { ContentQualityService } from "@/server/features/audit/services/ContentQualityService";
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
      "Page URL to grade. The page is fetched and scored on E-E-A-T " +
        "dimensions (trust, experience, expertise, authority), readability, " +
        "originality, plus templated-copy and over-optimization checks.",
    ),
} as const;

type Args = z.infer<z.ZodObject<typeof inputSchema>>;

export const getContentQualityTool = {
  name: "get_content_quality",
  config: {
    title: "Grade page content quality",
    description:
      "Grade one URL's copy: 0-100 overall with E-E-A-T sub-scores, " +
      "readability, filler/AI-pattern signals, templated-copy detection " +
      "(placeholder, stock CTAs), and meta-restates-title checks. " +
      "Uses no credits — no DataForSEO calls. Blocked for " +
      "private/internal targets.",
    inputSchema,
    outputSchema: z.looseObject({
      grade: z.looseObject({
        url: z.string(),
        finalUrl: z.string(),
        overall: z.number(),
        readingEase: z.number(),
        topTerm: z.string().nullable(),
        overOptimized: z.boolean(),
        descriptionRestatesTitle: z.boolean(),
        findingCount: z.number(),
      }),
      dimensions: z.looseObject({}),
      findings: z.array(
        z.looseObject({
          code: z.string(),
          message: z.string(),
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
    const result = await ContentQualityService.gradeUrl({
      projectId: args.projectId,
      url: args.url,
    });

    const topFindings = result.findings.slice(0, 3).map((f) => f.code);
    return mcpResponse({
      text:
        `Content grade for ${result.finalUrl}: ${result.overall}/100 ` +
        `(readability ${Math.round(result.readingEase)})` +
        (topFindings.length > 0
          ? ` — top findings: ${topFindings.join(", ")}`
          : " — no findings") +
        ".",
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/page-audit`,
      ),
      structuredContent: {
        grade: {
          url: result.url,
          finalUrl: result.finalUrl,
          overall: result.overall,
          readingEase: result.readingEase,
          topTerm: result.topTerm,
          overOptimized: result.overOptimized,
          descriptionRestatesTitle: result.descriptionRestatesTitle,
          findingCount: result.findings.length,
        },
        dimensions: result.dimensions,
        findings: result.findings.map((finding) => ({
          code: finding.code,
          message: finding.message,
        })),
      },
    });
  }),
};
