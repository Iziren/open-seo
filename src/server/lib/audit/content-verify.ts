/**
 * Content verification: claim/citation gaps plus draft-hygiene checks.
 *
 * The claim extractor is a port of `content_verify.py` — it finds
 * verifiable claims (statistics, quantities, authority attributions, dates,
 * comparisons) and reports which lack a nearby citation marker. The hygiene
 * checks cover what the audit needs beyond that: a meta description that
 * merely restates the title, placeholder/lorem text, and stock-CTA or
 * templated copy.
 *
 * Everything is advisory: results are returned as data (`findings`), not as
 * registered audit issue types, so a later scoring step decides what becomes
 * a user-visible issue. `ContentFinding` is the shared finding shape used by
 * the other content modules in this folder.
 */
import { sort } from "remeda";
import { z } from "zod";
import type { IssueSeverity } from "@/shared/audit-issues";

export interface ContentFinding {
  code: string;
  severity: IssueSeverity;
  message: string;
  howToFix: string;
  evidence: string[];
}

export type ClaimKind =
  | "statistic"
  | "quantity"
  | "authority"
  | "temporal"
  | "comparative";

export interface Claim {
  text: string;
  kind: ClaimKind;
  position: number;
  hasCitation: boolean;
  nearbyCitation: string | null;
}

export interface ClaimVerification {
  claims: Claim[];
  claimCount: number;
  uncitedCount: number;
  uncitedRatio: number;
}

export interface ContentVerifyInput {
  /** Visible page text (e.g. PageAnalysis.bodyText). */
  text: string;
  title?: string;
  metaDescription?: string;
}

export interface ContentVerification extends ClaimVerification {
  /** True when ≥80% of the description's content words appear in the title. */
  descriptionRestatesTitle: boolean;
  /** Share of the description's content words that appear in the title. */
  titleDescriptionOverlap: number;
  /** Placeholder/lorem/filler phrases found in the text. */
  placeholders: string[];
  /** Distinct stock CTA phrases found in the text. */
  stockCtas: string[];
  /** Un-rendered template markers such as `{{name}}` left in the copy. */
  templatedArtifacts: string[];
  findings: ContentFinding[];
}

/**
 * Claim patterns from content_verify.py, in priority order: earlier patterns
 * win overlapping spans so "47% of users" counts once as a statistic instead
 * of also double-counting as a quantity.
 */
const CLAIM_PATTERNS: ReadonlyArray<readonly [RegExp, ClaimKind]> = [
  [/\b\d+(?:\.\d+)?\s*%\s+of\s+[a-zA-Z]+(?:\s+[a-zA-Z]+){0,4}/gi, "statistic"],
  // No trailing \b: content_verify.py's `%\b` only fires when a word
  // character follows the %, so "rose 40%." never matched there. The % is
  // always terminal in real copy, so the assertion is dropped instead.
  [/\b\d+(?:\.\d+)?\s*%/g, "statistic"],
  [/\$\s?\d+(?:\.\d+)?\s*(?:million|billion|trillion|k|m|b)\b/gi, "quantity"],
  [/\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\s+\w+/g, "quantity"],
  [/\b\d+(?:\.\d+)?\s*(?:million|billion|trillion)\b/gi, "quantity"],
  [
    /\baccording\s+to\s+(?:a\s+)?(?:[A-Z][a-z]+\s+){1,4}(?:study|report|survey|analysis|paper)\b/g,
    "authority",
  ],
  [
    /\b(?:Forrester|Gartner|McKinsey|Pew|Nielsen|Statista|Deloitte|Edelman|MIT|Stanford|Harvard|Wharton)\s+(?:said|reports?|found|noted)/gi,
    "authority",
  ],
  [/\bin\s+(?:19|20)\d{2}\b/g, "temporal"],
  [/\bby\s+20\d{2}\b/g, "temporal"],
  [
    /\b\d+(?:\.\d+)?\s*(?:x|times)\s+(?:more|less|faster|slower|higher|lower|better|worse)\b/gi,
    "comparative",
  ],
  [/\b(?:twice|thrice|half)\s+as\s+\w+/gi, "comparative"],
];

// Citation markers searched in a ±200 char window around each claim. Unlike
// content_verify.py this pattern stays case-sensitive so `[A-Z]` really
// means a proper noun — the Python source applies IGNORECASE globally,
// which would credit "per page" as an attribution to a named source.
const CITATION_PATTERNS: RegExp[] = [
  /\[[^\]]+\]\(https?:\/\/[^)]+\)/, // markdown link
  /<a\s+[^>]*href=["']https?:\/\/[^"']+["']/i, // HTML link
  /\[\^?\d+\]/, // footnote-style [1] or [^1]
  /@type\s*:\s*["']Citation["']/i, // schema.org Citation
  /\b(?:source\s*:|via\s*:|see\s+also\s*:|cited\s+(?:in|by)|according\s+to|per)\s+(?:a\s+)?[A-Z]/,
];

const CITATION_WINDOW_CHARS = 200;
const UNCITED_RATIO_THRESHOLD = 0.4;

const PLACEHOLDER_PHRASES = [
  "lorem ipsum",
  "lorem dolor",
  "dolor sit amet",
  "placeholder text",
  "your text here",
  "text goes here",
  "insert text here",
  "under construction",
  "to be announced",
];
const PLACEHOLDER_TOKEN_RE = /\b(?:todo|tbd|fixme|xxx+)\b/gi;
const TEMPLATE_ARTIFACT_RE = /\{\{[^}]{1,80}\}\}|\{%[^%]{1,80}%\}/g;

const STOCK_CTA_PHRASES = [
  "learn more",
  "get started today",
  "get started now",
  "sign up now",
  "sign up today",
  "sign up for free",
  "start your free trial",
  "try it for free",
  "book a demo",
  "request a demo",
  "click here",
  "buy now",
  "shop now",
  "contact us today",
  "feel free to contact",
  "don't hesitate to contact",
  "we've got you covered",
  "take your business to the next level",
  "join thousands of",
];

// Function words excluded before comparing title vs description so a
// reworded-but-reordered copy ("Best shoes for running" in both) still
// counts as a restatement instead of hiding behind "for"/"the".
const COMPARE_STOP_WORDS = new Set(
  "the a an of and or to in for on with is are be this that it its as at by from we our your you not but if then than too very just also".split(
    " ",
  ),
);

// Exported so callers (MCP tools) can validate raw input before calling —
// these modules sit on an untrusted-input boundary.
export const contentVerifyInputSchema = z.object({
  text: z.string(),
  title: z.string().optional(),
  metaDescription: z.string().optional(),
});

function hasCitationNear(
  text: string,
  position: number,
  window: number = CITATION_WINDOW_CHARS,
): string | null {
  const snippet = text.slice(
    Math.max(0, position - window),
    Math.min(text.length, position + window),
  );
  for (const pattern of CITATION_PATTERNS) {
    const match = pattern.exec(snippet);
    if (match) return match[0].slice(0, 80);
  }
  return null;
}

/** Find every claim-like span; mark whether each has a nearby citation. */
export function verifyClaims(text: string): ClaimVerification {
  const spans: Array<{ start: number; end: number; kind: ClaimKind }> = [];
  for (const [pattern, kind] of CLAIM_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const start = match.index;
      if (start === undefined) continue;
      const end = start + match[0].length;
      // Skip spans an earlier (higher-priority) pattern already claimed.
      if (spans.some((span) => span.start < end && start < span.end)) continue;
      spans.push({ start, end, kind });
    }
  }

  const ordered = sort(spans, (a, b) => a.start - b.start);
  const claims = ordered.map((span) => {
    const nearbyCitation = hasCitationNear(text, span.start);
    return {
      text: text.slice(span.start, span.end).trim(),
      kind: span.kind,
      position: span.start,
      hasCitation: nearbyCitation !== null,
      nearbyCitation,
    };
  });
  const uncitedCount = claims.filter((claim) => !claim.hasCitation).length;
  return {
    claims,
    claimCount: claims.length,
    uncitedCount,
    uncitedRatio: claims.length
      ? Math.round((uncitedCount / claims.length) * 1000) / 1000
      : 0,
  };
}

function contentWords(value: string): Set<string> {
  const tokens = value.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return new Set(
    tokens.filter(
      (token) => token.length > 1 && !COMPARE_STOP_WORDS.has(token),
    ),
  );
}

function containmentRatio(inner: Set<string>, outer: Set<string>): number {
  if (inner.size === 0) return 0;
  let hits = 0;
  for (const token of inner) {
    if (outer.has(token)) hits += 1;
  }
  return hits / inner.size;
}

function detectPlaceholders(text: string): string[] {
  const lowered = text.toLowerCase();
  const hits = PLACEHOLDER_PHRASES.filter((phrase) => lowered.includes(phrase));
  for (const match of text.matchAll(PLACEHOLDER_TOKEN_RE)) {
    hits.push(match[0].toLowerCase());
  }
  return hits;
}

function detectStockCtas(text: string): string[] {
  const lowered = text.toLowerCase();
  return STOCK_CTA_PHRASES.filter((phrase) => lowered.includes(phrase));
}

/**
 * Verify a page's copy: claim/citation gaps, title-vs-description
 * redundancy, placeholder text, and stock/templated boilerplate. Input is
 * parsed with Zod because MCP tools will pass raw strings from outside.
 */
export function verifyContent(input: ContentVerifyInput): ContentVerification {
  const {
    text,
    title = "",
    metaDescription = "",
  } = contentVerifyInputSchema.parse(input);

  const claimVerification = verifyClaims(text);
  const titleWords = contentWords(title);
  const descriptionWords = contentWords(metaDescription);
  const titleDescriptionOverlap =
    descriptionWords.size > 0 && titleWords.size > 0
      ? containmentRatio(descriptionWords, titleWords)
      : 0;
  const descriptionRestatesTitle =
    descriptionWords.size >= 3 && titleDescriptionOverlap >= 0.8;

  const placeholders = detectPlaceholders(text);
  const stockCtas = detectStockCtas(text);
  const templatedArtifacts = (text.match(TEMPLATE_ARTIFACT_RE) ?? []).map(
    (artifact) => artifact.slice(0, 80),
  );

  const findings: ContentFinding[] = [];
  if (
    claimVerification.claimCount >= 3 &&
    claimVerification.uncitedRatio > UNCITED_RATIO_THRESHOLD
  ) {
    findings.push({
      code: "uncited-claims",
      severity: "warning",
      message: `${claimVerification.uncitedCount} of ${claimVerification.claimCount} verifiable claims have no nearby citation, source link, or attribution.`,
      howToFix:
        'Anchor each factual claim with a link to a primary source, a footnote reference, or an inline attribution such as "per <Source>".',
      evidence: [
        `uncited ratio ${claimVerification.uncitedRatio} (threshold ${UNCITED_RATIO_THRESHOLD})`,
        ...claimVerification.claims
          .filter((claim) => !claim.hasCitation)
          .slice(0, 3)
          .map((claim) => claim.text),
      ],
    });
  }
  if (descriptionRestatesTitle) {
    findings.push({
      code: "description-restates-title",
      severity: "info",
      message:
        "The meta description repeats the title tag instead of adding new snippet copy.",
      howToFix:
        "Rewrite the description to summarize the page's answer or offer — a different angle from the title, roughly 70–160 characters, with a reason to click.",
      evidence: [title, metaDescription],
    });
  }
  if (placeholders.length > 0) {
    findings.push({
      code: "placeholder-text",
      severity: "warning",
      message:
        "The visible copy contains placeholder/lorem text that was never replaced.",
      howToFix:
        "Replace every placeholder with real content, or remove the section until the copy is written.",
      evidence: placeholders,
    });
  }
  if (templatedArtifacts.length > 0) {
    findings.push({
      code: "template-artifacts",
      severity: "warning",
      message:
        "Un-rendered template variables (e.g. {{name}}) are visible in the page copy.",
      howToFix:
        "Fix the template so variables render, or remove the un-substituted markup from the published page.",
      evidence: templatedArtifacts,
    });
  }
  if (stockCtas.length >= 2) {
    findings.push({
      code: "stock-cta-copy",
      severity: "info",
      message: "The page leans on generic stock CTAs instead of specific copy.",
      howToFix:
        "Replace boilerplate calls to action with concrete, page-specific ones that state what the reader gets.",
      evidence: stockCtas,
    });
  }

  return {
    ...claimVerification,
    descriptionRestatesTitle,
    titleDescriptionOverlap: Math.round(titleDescriptionOverlap * 1000) / 1000,
    placeholders,
    stockCtas,
    templatedArtifacts,
    findings,
  };
}
