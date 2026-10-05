import { fetchAnalyzedPage } from "@/server/lib/audit/fetch-analyzed-page";
import type { QualityDimensions } from "@/server/lib/audit/content-quality";
import type { ContentFinding } from "@/server/lib/audit/content-verify";

export interface ContentGradeResult {
  url: string;
  finalUrl: string;
  overall: number;
  dimensions: QualityDimensions;
  findings: ContentFinding[];
  readingEase: number;
  readingGrade: number;
  topTerm: string | null;
  topTermDensity: number;
  overOptimized: boolean;
  descriptionRestatesTitle: boolean;
  placeholders: string[];
  stockCtas: string[];
}

async function gradeUrl(input: {
  projectId: string;
  url: string;
}): Promise<ContentGradeResult> {
  const { finalUrl, analysis } = await fetchAnalyzedPage(input.url);

  const [{ analyzeContentQuality }, { verifyContent }, { analyzeNlp }] =
    await Promise.all([
      import("@/server/lib/audit/content-quality"),
      import("@/server/lib/audit/content-verify"),
      import("@/server/lib/audit/nlp-analyze"),
    ]);

  const quality = analyzeContentQuality(analysis);
  const verification = verifyContent({
    text: analysis.bodyText,
    title: analysis.title,
    metaDescription: analysis.metaDescription,
  });
  const nlp = analyzeNlp({
    text: analysis.bodyText,
    title: analysis.title,
    h1: analysis.h1s[0] ?? "",
  });

  return {
    url: input.url,
    finalUrl,
    overall: quality.overall,
    dimensions: quality.dimensions,
    findings: [...quality.findings, ...verification.findings],
    readingEase: nlp.readingLevel.fleschReadingEase,
    readingGrade: nlp.readingLevel.fleschKincaidGrade,
    topTerm: nlp.density.topTerm?.term ?? null,
    topTermDensity: nlp.density.topTerm?.density ?? 0,
    overOptimized: nlp.density.overOptimized,
    descriptionRestatesTitle: verification.descriptionRestatesTitle,
    placeholders: verification.placeholders,
    stockCtas: verification.stockCtas,
  };
}

export const ContentQualityService = {
  gradeUrl,
} as const;
