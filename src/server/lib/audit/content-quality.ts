/**
 * E-E-A-T aligned content quality scorer.
 *
 * `scoreText` is a faithful port of content_quality.py's `analyse()`: it
 * scores a body of text against the three lowest-rating triggers from
 * Google's September 11, 2025 Quality Rater Guidelines — §4.6.5 scaled
 * content abuse, §4.6.6 AI/copied content, and §4.6 filler content.
 * `analyzeContentQuality` layers the E-E-A-T dimension scores on top: per
 * the same QRG revision, Trust is the top-most factor, so it carries the
 * largest weight in the composite.
 *
 * Advisory only: these are heuristic signals, never a "this is AI" verdict.
 * Findings are returned as data (shared `ContentFinding` shape) rather than
 * registered issue types; the audit scoring step decides what becomes an
 * issue.
 *
 * The AI-pattern list is the Wikipedia "AI Cleanup" catalogue of
 * LLM-typical phrasings (CC BY-SA 4.0), also used by
 * ivankuznetsov/claude-seo (MIT); patterns are kept conservative.
 */
import { verifyClaims } from "./content-verify";
import type { ClaimVerification, ContentFinding } from "./content-verify";
import { readingLevel } from "./nlp-analyze";
import type { ReadingLevel } from "./nlp-analyze";
import type { IssueSeverity } from "@/shared/audit-issues";
import type { PageAnalysis } from "./types";

// The phrase lists below are pipe-delimited string literals rather than
// arrays: prettier expands a long array to one element per line, and these
// data lists alone would consume the file's oxlint max-lines budget.
/** Padding / filler phrases that QRG §4.6 flags as "little-to-no value". */
const FILLER_PHRASES =
  "it's important to note that|in this article, we'll explore|in this article we will explore|in today's fast-paced world|in today's digital age|in today's competitive landscape|needless to say|at the end of the day|when it comes to|when all is said and done|in the realm of|in the world of|the bottom line is|without further ado|first and foremost|last but not least|for what it's worth|it goes without saying|as we all know|the truth is that|the fact of the matter is|more often than not|let's dive in|let's dive into|let's take a closer look|let's take a deeper look".split(
    "|",
  );

// LLM-typical phrasings (Wikipedia AI Cleanup catalogue, CC BY-SA 4.0;
// also used by ivankuznetsov/claude-seo, MIT). Adding to this list should
// require corpus evidence, not intuition.
const AI_PATTERNS =
  "delve into|delve deeper into|in the ever-evolving|ever-evolving landscape|ever-changing landscape|in the dynamic landscape|navigating the|navigate the complexities|tapestry of|rich tapestry|intricate tapestry|embark on a journey|embarking on this|a testament to|a beacon of|the cornerstone of|a cornerstone of|at the heart of|at its core|in essence,|in conclusion,|ultimately,|moreover,|furthermore,|however, it's worth noting|it's worth noting that|by leveraging|leverage the power of|leveraging the power of|harness the power of|unlock the potential|unlock the full potential|the realm of possibilities|open up a world of|a world of possibilities|elevate your|transform your|revolutionize the way|game-changer|game-changing|cutting-edge|state-of-the-art|in summary,|to summarize,|to put it simply,|in a nutshell,".split(
    "|",
  );

// Latin words, Hangul eojeol, and CJK/kana characters — same classes as
// content_quality.py, so token counts stay comparable to the script.
const TOKEN_RE = /[A-Za-z][A-Za-z'-]*|[가-힣]+|[ぁ-ゖァ-ヺー]|[㐀-䶿一-鿿]/g;
const NUMBER_RE = /\b\d+(?:[.,]\d+)?(?:%|st|nd|rd|th)?\b/g;
const ENTITY_RE = /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g;
const CJK_CHAR_RE = /[가-힣ぁ-ゖァ-ヺー㐀-䶿一-鿿]/g;
const LATIN_CHAR_RE = /[A-Za-z]/g;

const FIRST_HAND_RE =
  /\b(?:we tested|we tried|we used|we ran|we built|we compared|we reviewed|in our experience|hands[- ]on|our team)\b/i;
const FIRST_PERSON_RE = /\b(?:i|we|our|us|my)\b/gi;
const FRESHNESS_RE = /\b(?:updated|published|reviewed)\b/i;
const YEAR_RE = /\b(?:19|20)\d{2}\b/;
const EXPERT_MARKER_RE =
  /\b(?:expert|certified|researcher|specialist|methodology|peer[- ]reviewed|data shows|study found|years of experience|reviewed by|we recommend)\b/gi;
const ATTRIBUTION_RE =
  /\b(?:according to|source\s*:|reported by|cited (?:in|by))\b/i;
const PER_PROPER_RE = /\bper\s+[A-Z]/;
const REFERENCE_HOST_RE = /\.(?:edu|gov|mil)\b|wikipedia\.org/i;

export type QualityFlag =
  | "empty-input"
  | "filler"
  | "ai-patterns"
  | "low-density"
  | "repetitive"
  | "thin-content";

export interface TextCoverageNote {
  script: "cjk";
  entityDensity: "not_computed";
  phraseLists: "english_only";
}

/** Raw text metrics — higher filler/ai/repetition scores are worse. */
export interface TextQualitySignals {
  fillerScore: number;
  aiPatternScore: number;
  informationDensity: number;
  repetitionScore: number;
  flags: QualityFlag[];
  matches: { filler: string[]; aiPatterns: string[] };
  tokens: number;
  uniqueTokens: number;
  /** Present only for CJK-dominant text: English-only signals skipped. */
  coverage?: TextCoverageNote;
}

/**
 * E-E-A-T sub-scores, each 0-100 and higher-is-better — including
 * `thinness`, which is the content-depth score (100 = substantial,
 * 0 = empty page).
 */
export interface QualityDimensions {
  trust: number;
  experience: number;
  expertise: number;
  authority: number;
  readability: number;
  originality: number;
  thinness: number;
}

export interface ContentQualityResult {
  /** Normalized 0-100 composite; Trust-weighted per the Sept 2025 QRG. */
  overall: number;
  dimensions: QualityDimensions;
  /** The finding codes below, ready for a scoring step to consume. */
  findings: ContentFinding[];
  fillerScore: number;
  aiPatternScore: number;
  informationDensity: number;
  repetitionScore: number;
  flags: QualityFlag[];
  matches: { filler: string[]; aiPatterns: string[] };
  tokens: number;
  uniqueTokens: number;
  coverage?: TextCoverageNote;
}

function clampScore(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value)));
}

/** "cjk" when CJK/Hangul/kana characters dominate the text. */
function detectScript(text: string): "cjk" | null {
  const cjkChars = text.match(CJK_CHAR_RE)?.length ?? 0;
  if (cjkChars === 0) return null;
  const latinChars = text.match(LATIN_CHAR_RE)?.length ?? 0;
  return cjkChars >= latinChars ? "cjk" : null;
}

function countPhraseHits(text: string, patterns: readonly string[]): string[] {
  const lowered = text.toLowerCase();
  return patterns.filter((pattern) => lowered.includes(pattern));
}

/** Bigram repetition: fraction of bigram types that recur more than once. */
function repetitionScore(tokens: string[]): number {
  if (tokens.length < 4) return 0;
  const counts = new Map<string, number>();
  for (let i = 0; i < tokens.length - 1; i++) {
    const bigram = `${tokens[i]} ${tokens[i + 1]}`;
    counts.set(bigram, (counts.get(bigram) ?? 0) + 1);
  }
  let repeated = 0;
  for (const value of counts.values()) {
    if (value > 1) repeated += 1;
  }
  return repeated / Math.max(1, counts.size);
}

/** Port of content_quality.py `analyse()`: QRG filler/AI/density metrics. */
export function scoreText(text: string): TextQualitySignals {
  if (!text.trim()) {
    return {
      fillerScore: 0,
      aiPatternScore: 0,
      informationDensity: 0,
      repetitionScore: 0,
      flags: ["empty-input"],
      matches: { filler: [], aiPatterns: [] },
      tokens: 0,
      uniqueTokens: 0,
    };
  }

  const tokens = (text.match(TOKEN_RE) ?? []).map((token) =>
    token.toLowerCase(),
  );
  const nTokens = tokens.length;
  const fillerHits = countPhraseHits(text, FILLER_PHRASES);
  const aiHits = countPhraseHits(text, AI_PATTERNS);

  // Density: entities + numbers per 100 tokens; a data-heavy article lands
  // ~5+, a generic filler post <2. CJK text finds no entities (caseless
  // script), so its density rests on numbers alone — coverage reports that.
  const entities = text.match(ENTITY_RE)?.length ?? 0;
  const numbers = text.match(NUMBER_RE)?.length ?? 0;
  const densityPer100 = ((entities + numbers) * 100) / Math.max(1, nTokens);
  const informationDensity =
    Math.round(Math.min(1, densityPer100 / 10) * 1000) / 1000;

  const repetition = Math.round(repetitionScore(tokens) * 100);
  // Scale phrase hits per 1000 tokens so scores compare across lengths.
  const scale = Math.max(1, nTokens / 1000);
  const fillerScore = Math.min(
    100,
    Math.round((fillerHits.length / scale) * 25),
  );
  const aiPatternScore = Math.min(
    100,
    Math.round((aiHits.length / scale) * 15),
  );

  const flags: QualityFlag[] = [];
  if (fillerScore >= 50) flags.push("filler");
  if (aiPatternScore >= 40) flags.push("ai-patterns");
  if (informationDensity < 0.2) flags.push("low-density");
  if (repetition >= 30) flags.push("repetitive");
  if (nTokens < 300) flags.push("thin-content");

  const signals: TextQualitySignals = {
    fillerScore,
    aiPatternScore,
    informationDensity,
    repetitionScore: repetition,
    flags,
    matches: { filler: fillerHits, aiPatterns: aiHits },
    tokens: nTokens,
    uniqueTokens: new Set(tokens).size,
  };
  // The filler/AI phrase lists and the capitalisation entity heuristic are
  // English-only; say so rather than reporting "no filler found" for CJK.
  if (detectScript(text) === "cjk") {
    signals.coverage = {
      script: "cjk",
      entityDensity: "not_computed",
      phraseLists: "english_only",
    };
  }
  return signals;
}

function trustScore(analysis: PageAnalysis, claims: ClaimVerification): number {
  let score = 0;
  if (analysis.url.startsWith("https://")) score += 25;
  if (analysis.canonical) score += 10;
  if (analysis.hasStructuredData) score += 15;
  if (analysis.metaDescription) score += 10;
  if (analysis.links.some((link) => !link.isInternal)) score += 20;
  if (analysis.links.some((link) => link.isInternal)) score += 5;
  if (claims.claimCount > 0) {
    score +=
      claims.uncitedRatio <= 0.4 ? 15 : claims.uncitedRatio <= 0.7 ? 7 : 0;
  }
  return clampScore(score);
}

function experienceScore(text: string, images: PageAnalysis["images"]): number {
  const firstPerson = text.match(FIRST_PERSON_RE)?.length ?? 0;
  let score = Math.min(45, firstPerson * 3);
  if (FIRST_HAND_RE.test(text)) score += 20;
  if (images.some((image) => image.alt && image.alt.trim())) score += 25;
  if (FRESHNESS_RE.test(text) && YEAR_RE.test(text)) score += 10;
  return clampScore(score);
}

function expertiseScore(
  analysis: PageAnalysis,
  informationDensity: number,
): number {
  // Information density is the strongest local proxy for subject-matter
  // depth: concrete entities and numbers per token.
  let score = informationDensity * 100 * 0.5;
  if (analysis.headingOrder.includes(2)) score += 20;
  if (analysis.headingOrder.length >= 4) score += 10;
  const markers = analysis.bodyText.match(EXPERT_MARKER_RE)?.length ?? 0;
  score += Math.min(20, markers * 4);
  return clampScore(score);
}

function authorityScore(
  analysis: PageAnalysis,
  claims: ClaimVerification,
): number {
  const external = analysis.links.filter((link) => !link.isInternal).length;
  let score = external >= 5 ? 40 : external >= 3 ? 30 : external >= 1 ? 20 : 0;
  if (analysis.links.some((link) => REFERENCE_HOST_RE.test(link.targetUrl))) {
    score += 20;
  }
  const text = analysis.bodyText;
  if (ATTRIBUTION_RE.test(text) || PER_PROPER_RE.test(text)) score += 20;
  if (claims.claimCount > 0) {
    score +=
      claims.uncitedRatio <= 0.4 ? 25 : claims.uncitedRatio <= 0.7 ? 12 : 0;
  }
  if (analysis.links.filter((link) => link.isInternal).length >= 3) score += 15;
  return clampScore(score);
}

function buildFindings(
  signals: TextQualitySignals,
  dimensions: QualityDimensions,
  claims: ClaimVerification,
  reading: ReadingLevel,
): ContentFinding[] {
  const out: ContentFinding[] = [];
  const { flags, matches } = signals;
  const add = (
    code: string,
    severity: IssueSeverity,
    message: string,
    howToFix: string,
    evidence: string[],
  ): void => {
    out.push({ code, severity, message, howToFix, evidence });
  };
  if (flags.includes("empty-input")) {
    add(
      "empty-text",
      "warning",
      "The page has no visible text to assess.",
      "Serve the page's main content in the initial HTML; if content renders client-side, pre-render it.",
      [`${signals.tokens} tokens`],
    );
    return out;
  }
  if (flags.includes("filler")) {
    add(
      "filler-content",
      "warning",
      `Padding phrases QRG §4.6 treats as "little-to-no value" appear ${matches.filler.length}× on the page.`,
      "Replace each padding phrase with the specific point you make, or delete the transition entirely.",
      matches.filler.slice(0, 5),
    );
  }
  if (flags.includes("ai-patterns")) {
    add(
      "ai-pattern-signal",
      "warning",
      `The copy uses ${matches.aiPatterns.length} phrasings that appear disproportionately in LLM output — an advisory signal, not an AI verdict.`,
      "Rewrite the flagged spans in your own voice with concrete details from real experience; treat this as a prompt to revise, not proof of authorship.",
      matches.aiPatterns.slice(0, 5),
    );
  }
  if (flags.includes("low-density")) {
    add(
      "low-information-density",
      "info",
      `Information density is ${signals.informationDensity.toFixed(2)} (below 0.20): the text carries few names, figures, or facts.`,
      "Add the numbers, entity names, dates, and examples that make a page worth citing.",
      [`density ${signals.informationDensity.toFixed(2)} (0..1)`],
    );
  }
  if (flags.includes("repetitive")) {
    add(
      "repetitive-copy",
      "info",
      `${signals.repetitionScore}% of the page's bigrams repeat more than once — the same phrasing is recycled.`,
      "Vary the phrasing, merge the repeated passages, or cut the duplicated sections.",
      [`repetition score ${signals.repetitionScore}/100`],
    );
  }
  if (flags.includes("thin-content")) {
    add(
      "thin-text",
      "warning",
      `The body text has only ${signals.tokens} tokens (under 300), too little for a standalone page.`,
      "Expand the page with genuinely useful content, consolidate it into a stronger page, or noindex it.",
      [`${signals.tokens} tokens`],
    );
  }
  if (dimensions.trust < 50) {
    add(
      "weak-trust-signals",
      "warning",
      `Trust signals score ${dimensions.trust}/100 — few of HTTPS, canonical, structured data, sources, and cited claims are present.`,
      "Add cited sources and an external reference link, declare a canonical, mark up structured data, and serve over HTTPS.",
      [`trust ${dimensions.trust}/100`],
    );
  }
  if (dimensions.experience < 40) {
    add(
      "weak-experience-signals",
      "info",
      `Experience signals score ${dimensions.experience}/100: little first-hand language, described imagery, or recency.`,
      "Add first-person accounts of what you actually tested or did, describe your own images, and show when the page was written or updated.",
      [`experience ${dimensions.experience}/100`],
    );
  }
  if (reading.fleschReadingEase < 30) {
    add(
      "hard-to-read",
      "info",
      `Reading ease is ${reading.fleschReadingEase}/100 (Flesch–Kincaid grade ${reading.fleschKincaidGrade}) — dense, hard-to-parse prose.`,
      "Shorten sentences and use plainer words for the key points; keep specialist detail for later paragraphs.",
      [
        `ease ${reading.fleschReadingEase}`,
        `grade ${reading.fleschKincaidGrade}`,
      ],
    );
  }
  if (signals.coverage) {
    add(
      "cjk-coverage-limited",
      "info",
      "CJK text detected: filler/AI phrase lists and entity density are English-only heuristics, so this score is not comparable to a Latin-script page.",
      "Interpret the filler, AI-pattern, and density signals for this page qualitatively, not numerically.",
      ["signals skipped: entity density, phrase lists"],
    );
  }
  return out;
}

/**
 * Score a page's E-E-A-T quality: per-dimension sub-scores, a normalized
 * 0-100 composite weighted with Trust top-most (Google's Sept 2025 QRG),
 * the ported QRG text signals, and advisory findings as data.
 */
export function analyzeContentQuality(
  analysis: PageAnalysis,
): ContentQualityResult {
  const text = analysis.bodyText;
  const signals = scoreText(text);
  const claims = verifyClaims(text);
  const reading = readingLevel(text);

  const dimensions: QualityDimensions = {
    trust: trustScore(analysis, claims),
    experience: experienceScore(text, analysis.images),
    expertise: expertiseScore(analysis, signals.informationDensity),
    authority: authorityScore(analysis, claims),
    readability: clampScore(reading.fleschReadingEase),
    originality: clampScore(100 - signals.aiPatternScore),
    thinness: Math.min(100, Math.round(signals.tokens / 10)),
  };

  // Trust carries the largest weight (QRG: Trust is the top-most factor),
  // then expertise/authority, then experience/originality, then the
  // readability and depth garnish.
  const overall = Math.round(
    dimensions.trust * 0.3 +
      dimensions.experience * 0.12 +
      dimensions.expertise * 0.15 +
      dimensions.authority * 0.13 +
      dimensions.readability * 0.08 +
      dimensions.originality * 0.12 +
      dimensions.thinness * 0.1,
  );

  return {
    overall,
    dimensions,
    findings: buildFindings(signals, dimensions, claims, reading),
    fillerScore: signals.fillerScore,
    aiPatternScore: signals.aiPatternScore,
    informationDensity: signals.informationDensity,
    repetitionScore: signals.repetitionScore,
    flags: signals.flags,
    matches: signals.matches,
    tokens: signals.tokens,
    uniqueTokens: signals.uniqueTokens,
    ...(signals.coverage ? { coverage: signals.coverage } : {}),
  };
}
