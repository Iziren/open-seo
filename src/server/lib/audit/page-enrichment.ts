import type {
  NlpSummary,
  PageAnalysis,
  PageSchemaFinding,
  PageSchemaStatus,
} from "./types";
import type { NlpAnalysis } from "./nlp-analyze";
import type { SchemaExtraction } from "./schema-extract";
import type { SchemaValidationResult } from "./schema-validate";

/** Cap persisted JSON-LD type lists so one pathological page can't bloat its row. */
const MAX_SCHEMA_TYPES = 10;
/** Cap persisted validation findings; the verdict, not the prose, drives scoring. */
const MAX_SCHEMA_FINDINGS = 5;
const MAX_FINDING_MESSAGE_CHARS = 200;

export interface PageEnrichment {
  contentScore: number;
  contentFindings: string[];
  schemaStatus: PageSchemaStatus;
  schemaTypes: string[];
  schemaFindings: PageSchemaFinding[];
  nlpSummary: NlpSummary | null;
}

/**
 * Content-quality + schema enrichment for one analyzed page. CPU-only scans
 * over the already-buffered HTML and body text (bounded by MAX_HTML_BYTES),
 * far cheaper than the fetch + parse + hash already spent per page — so
 * every analyzed HTML page is enriched, with no sampling. The modules stay
 * dynamically imported behind the same lazy seam as page-analyzer.
 */
export async function enrichPageAnalysis(
  analysis: PageAnalysis,
  html: string,
): Promise<PageEnrichment> {
  const [
    { analyzeContentQuality },
    { extractSchemaFromHtml },
    { validateSchema },
    { analyzeNlp },
  ] = await Promise.all([
    import("@/server/lib/audit/content-quality"),
    import("@/server/lib/audit/schema-extract"),
    import("@/server/lib/audit/schema-validate"),
    import("@/server/lib/audit/nlp-analyze"),
  ]);
  const quality = analyzeContentQuality(analysis);
  const nlp = analyzeNlp({
    text: analysis.bodyText,
    title: analysis.title,
    h1: analysis.h1s[0] ?? "",
  });
  return {
    contentScore: quality.overall,
    contentFindings: quality.findings.map((finding) => finding.code),
    ...summarizeSchema(extractSchemaFromHtml(html), validateSchema),
    nlpSummary: summarizeNlp(nlp),
  };
}

function summarizeSchema(
  extraction: SchemaExtraction,
  validate: (payload: unknown) => SchemaValidationResult,
): {
  schemaStatus: PageSchemaStatus;
  schemaTypes: string[];
  schemaFindings: PageSchemaFinding[];
} {
  const types = [...new Set(extraction.entities.flatMap((e) => e.types))].slice(
    0,
    MAX_SCHEMA_TYPES,
  );
  if (extraction.scripts.length === 0) {
    return { schemaStatus: "missing", schemaTypes: [], schemaFindings: [] };
  }
  const parseErrors = extraction.scripts.flatMap((script) =>
    script.ok
      ? []
      : [
          {
            code: "jsonld-parse-error",
            message: `script #${script.scriptIndex}: ${script.error}`.slice(
              0,
              MAX_FINDING_MESSAGE_CHARS,
            ),
          },
        ],
  );
  if (parseErrors.length > 0) {
    return {
      schemaStatus: "invalid",
      schemaTypes: types,
      schemaFindings: parseErrors.slice(0, MAX_SCHEMA_FINDINGS),
    };
  }
  // validateSchema encodes merchant-listing policy (it errors when no
  // Product block exists), so it only judges pages that actually attempt
  // Product markup — running it on Article/FAQ pages would fail every blog.
  const hasProduct = extraction.entities.some((entity) =>
    entity.types.includes("Product"),
  );
  if (!hasProduct) {
    return { schemaStatus: "valid", schemaTypes: types, schemaFindings: [] };
  }
  // Entities are normalized out of their script roots, which carried the
  // document-level @context — re-anchor on schema.org instead of
  // false-positiving missing-context on every page.
  const validation = validate({
    "@context": "https://schema.org",
    "@graph": extraction.entities.map((entity) => entity.value),
  });
  const schemaFindings = [...validation.errors, ...validation.warnings]
    .slice(0, MAX_SCHEMA_FINDINGS)
    .map((finding) => ({
      code: finding.code,
      message: finding.message.slice(0, MAX_FINDING_MESSAGE_CHARS),
    }));
  return {
    schemaStatus: validation.ok ? "valid" : "invalid",
    schemaTypes: types,
    schemaFindings,
  };
}

function summarizeNlp(nlp: NlpAnalysis): NlpSummary | null {
  if (nlp.tokenCount === 0) return null;
  return {
    tokenCount: nlp.tokenCount,
    readingEase: nlp.readingLevel.fleschReadingEase,
    grade: nlp.readingLevel.fleschKincaidGrade,
    topTerm: nlp.density.topTerm?.term ?? null,
    topTermDensity: nlp.density.topTerm?.density ?? 0,
    overOptimized: nlp.density.overOptimized,
    titleCoverage: nlp.coverage.titleCoverage,
    h1Coverage: nlp.coverage.h1Coverage,
  };
}
