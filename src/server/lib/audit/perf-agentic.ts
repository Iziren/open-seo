/**
 * Agentic / AI-crawl readiness (port of `lighthouse_agentic.py`).
 *
 * Deterministic readiness signal from data available locally: the Lighthouse
 * agentic-browsing category fraction when an LHR is provided, plus page
 * signals the audit already collects (render mode, llms.txt, robots,
 * structured data, semantics). Pure throughout; no external calls.
 */

export const AGENTIC_CATEGORY_ID = "agentic-browsing";
// RATINGS.PASS.minScore in the Lighthouse report renderer.
export const AGENTIC_PASS_MIN_SCORE = 0.9;

export type AgenticAuditStatus =
  | "pass"
  | "fail"
  | "informative"
  | "not-applicable"
  | "manual"
  | "hidden"
  | "missing";

export interface AgenticAuditRef {
  id: string;
  group?: string;
}

export interface AgenticAudit {
  score?: number | null;
  scoreDisplayMode?: string;
  title?: string;
  displayValue?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && !Number.isNaN(value) ? value : null;
}

/**
 * How one auditRef contributes to the category fraction. Mirrors
 * ReportUtils.calculateCategoryFraction: informative audits never count,
 * everything else passes at score >= 0.9.
 */
export function classifyAgenticAudit(
  ref: AgenticAuditRef,
  audit: AgenticAudit | undefined,
): AgenticAuditStatus {
  if (!audit) return "missing";
  if (ref.group === "hidden") return "hidden";
  if (audit.scoreDisplayMode === "manual") return "manual";
  if (audit.scoreDisplayMode === "notApplicable") return "not-applicable";
  if (audit.scoreDisplayMode === "informative") return "informative";
  if (audit.scoreDisplayMode === "error" || audit.score == null) return "fail";
  return audit.score >= AGENTIC_PASS_MIN_SCORE ? "pass" : "fail";
}

export type AgenticFraction =
  | { available: false }
  | {
      available: true;
      passed: number;
      counted: number;
      informative: number;
      display: string;
      categoryScore: number | null;
    };

function readAgenticRef(
  ref: unknown,
  audits: Record<string, unknown>,
): { counted: "pass" | "fail" | null; informative: boolean } {
  if (!isRecord(ref) || typeof ref["id"] !== "string") {
    return { counted: null, informative: false };
  }
  const audit = audits[ref["id"]];
  if (!isRecord(audit)) return { counted: null, informative: false };
  const score = audit["score"];
  const status = classifyAgenticAudit(
    {
      id: ref["id"],
      group: typeof ref["group"] === "string" ? ref["group"] : undefined,
    },
    {
      score: asNumber(score),
      scoreDisplayMode:
        typeof audit["scoreDisplayMode"] === "string"
          ? audit["scoreDisplayMode"]
          : undefined,
    },
  );
  if (status === "informative") return { counted: null, informative: true };
  if (status === "pass" || status === "fail")
    return { counted: status, informative: false };
  return { counted: null, informative: false };
}

/** Reproduce the renderer's fraction from the result's own auditRefs. */
export function calculateAgenticFraction(lhr: unknown): AgenticFraction {
  if (!isRecord(lhr)) return { available: false };
  const { categories, audits } = lhr;
  if (!isRecord(categories) || !isRecord(audits)) return { available: false };
  const category = categories[AGENTIC_CATEGORY_ID];
  if (!isRecord(category) || !Array.isArray(category["auditRefs"])) {
    return { available: false };
  }
  let passed = 0;
  let counted = 0;
  let informative = 0;
  for (const ref of category["auditRefs"]) {
    const result = readAgenticRef(ref, audits);
    if (result.informative) informative += 1;
    if (result.counted) {
      counted += 1;
      if (result.counted === "pass") passed += 1;
    }
  }
  return {
    available: true,
    passed,
    counted,
    informative,
    display: `${passed}/${counted}`,
    categoryScore: asNumber(category["score"]),
  };
}

// Verified against Lighthouse 13.5.0 in the Python source; the fraction is
// always read from auditRefs so renamed audits still report.
export const AGENTIC_AUDIT_NOTES: Record<string, string> = {
  "agent-accessibility-tree":
    "Fails when any axe rule fails (names/labels, ARIA validity, tree structure, tabindex). Fix the listed rules.",
  "webmcp-form-coverage":
    "Informative until every form has a toolname or tooldescription; then counts as a binary pass. N/A with no forms.",
  "webmcp-registered-tools":
    "Always informative; lists tools seen during load and never changes the fraction.",
  "webmcp-schema-validity":
    "Scores 0 on errors and 0.5 on warnings, so both count as failure. N/A when no tools and no issues exist.",
  "cumulative-layout-shift":
    "Numeric lab CLS; passes at score 0.9+ (about CLS 0.1 or less).",
  "llms-txt":
    "Binary: /llms.txt needs an H1, one Markdown link, and 50+ characters. A 4xx is N/A; a 5xx or fetch error fails.",
  "ard-schema":
    "Validates ai-catalog.json. N/A unless a catalog is signalled or /.well-known/ai-catalog.json returns 200.",
};

export interface AgenticPageSignals {
  /** Server-rendered HTML vs an empty JS shell agents may not execute. */
  renderMode?: "ssr" | "spa-shell" | "unknown";
  llmsTxt?: { served: boolean; valid: boolean };
  /** True when robots blocks known AI/data crawlers site-wide. */
  aiCrawlersBlocked?: boolean;
  structuredData?: { hasJsonLd: boolean };
  semantics?: { hasH1: boolean; htmlLang: boolean };
}

export interface AgenticCheck {
  id: string;
  label: string;
  status: "pass" | "fail" | "na";
  detail: string;
  fix: string | null;
}

export interface AgenticReadiness {
  checks: AgenticCheck[];
  /** Human-actionable fixes, one per failed check. */
  fixes: string[];
  fraction: AgenticFraction;
  /** Share of applicable checks passing, or null when none apply. */
  score: number | null;
}

function check(
  id: string,
  label: string,
  status: AgenticCheck["status"],
  detail: string,
  fix: string | null = null,
): AgenticCheck {
  return { id, label, status, detail, fix };
}

/**
 * Combine the LHR fraction with local page signals. Each check documents
 * the exact rule in the report output; the rule set is fixed below.
 */
export function summarizeAgenticReadiness(input: {
  lhr?: unknown;
  signals?: AgenticPageSignals;
}): AgenticReadiness {
  const checks: AgenticCheck[] = [];
  const fraction =
    input.lhr === undefined
      ? { available: false as const }
      : calculateAgenticFraction(input.lhr);

  if (fraction.available) {
    if (fraction.counted === 0) {
      checks.push(
        check(
          "agentic-category",
          "Agentic browsing category",
          "na",
          "Category present but no counted audits.",
        ),
      );
    } else if (fraction.passed === fraction.counted) {
      checks.push(
        check(
          "agentic-category",
          "Agentic browsing category",
          "pass",
          `${fraction.display} audits passed.`,
        ),
      );
    } else {
      const failing = fraction.counted - fraction.passed;
      checks.push(
        check(
          "agentic-category",
          "Agentic browsing category",
          "fail",
          `${fraction.display} audits passed (${failing} failing).`,
          "Fix failing agentic-browsing audits; informative audits never count toward the fraction.",
        ),
      );
    }
  }

  const signals = input.signals ?? {};
  if (signals.renderMode && signals.renderMode !== "unknown") {
    checks.push(
      signals.renderMode === "ssr"
        ? check(
            "render-mode",
            "Server-rendered HTML",
            "pass",
            "Meaningful HTML arrives without JS execution.",
          )
        : check(
            "render-mode",
            "Server-rendered HTML",
            "fail",
            "Page is a JS shell; agents without execution see an empty page.",
            "Server-render critical content or prerender; verify the raw HTML carries text.",
          ),
    );
  }
  if (signals.llmsTxt) {
    checks.push(
      signals.llmsTxt.served && signals.llmsTxt.valid
        ? check(
            "llms-txt",
            "llms.txt discovery",
            "pass",
            "/llms.txt is served and valid.",
          )
        : signals.llmsTxt.served
          ? check(
              "llms-txt",
              "llms.txt discovery",
              "fail",
              "/llms.txt is served but invalid.",
              // Discovery file only, never a ranking lever.
              "Serve /llms.txt with an H1, a summary, and Markdown links (50+ characters).",
            )
          : check(
              "llms-txt",
              "llms.txt discovery",
              "na",
              "/llms.txt is not served (discovery file only).",
            ),
    );
  }
  if (signals.aiCrawlersBlocked !== undefined) {
    checks.push(
      signals.aiCrawlersBlocked
        ? check(
            "robots-ai",
            "AI crawler access",
            "fail",
            "robots blocks known AI/data crawlers site-wide.",
            "Verify the block is intentional; scope it to paths you truly want excluded.",
          )
        : check(
            "robots-ai",
            "AI crawler access",
            "pass",
            "No site-wide AI-crawler block.",
          ),
    );
  }
  if (signals.structuredData) {
    checks.push(
      signals.structuredData.hasJsonLd
        ? check(
            "structured-data",
            "Structured data",
            "pass",
            "JSON-LD present for entity grounding.",
          )
        : check(
            "structured-data",
            "Structured data",
            "fail",
            "No JSON-LD found.",
            "Add valid JSON-LD matching visible page content so agents can ground entities.",
          ),
    );
  }
  if (signals.semantics) {
    const ok = signals.semantics.hasH1 && signals.semantics.htmlLang;
    checks.push(
      ok
        ? check(
            "semantics",
            "Page semantics",
            "pass",
            "H1 and html lang are present.",
          )
        : check(
            "semantics",
            "Page semantics",
            "fail",
            "Missing H1 and/or html lang attribute.",
            "Provide exactly one descriptive H1 and a valid html lang for parsing and TTS.",
          ),
    );
  }

  const applicable = checks.filter((item) => item.status !== "na");
  const passed = applicable.filter((item) => item.status === "pass").length;
  return {
    checks,
    fixes: checks
      .filter((item) => item.status === "fail" && item.fix)
      .map((item) => `${item.label}: ${item.fix}`),
    fraction,
    score:
      applicable.length === 0
        ? null
        : Math.round((passed / applicable.length) * 100),
  };
}
