/**
 * AI-search citability scorer: port of the `seo-geo` skill methodology.
 * Answer engines quote pages with self-contained passages, query-shaped
 * headings, attributable claims, and readable authorship/freshness — hence
 * the skill's five weighted criteria (25/20/20/20/15). Off-page brand
 * presence needs SERP data this pure module cannot fetch, so it is
 * unscored; llms.txt carries zero citation weight per Google (June 2026),
 * so it is reported in one line, never scored. Worker-safe, no I/O.
 */
import { Parser } from "htmlparser2";
import { z } from "zod";
import type { IssueSeverity } from "@/shared/audit-issues";
import { analyzeHtml } from "./page-analyzer";
import type { PageAnalysis } from "./types";

export const geoInputSchema = z.object({
  html: z.string(),
  url: z.string().min(1),
  crawl: z
    .object({
      // Search-crawler access from robots.txt (null = not supplied).
      robotsSearchAllowed: z.boolean().nullable().optional(),
      // llms.txt presence; reported only, never scored.
      llmsTxtPresent: z.boolean().nullable().optional(),
    })
    .optional(),
});

export type GeoInput = z.input<typeof geoInputSchema>;
export type GeoFactorCode =
  | "passages"
  | "structure"
  | "authority"
  | "technical"
  | "multimodal";
export interface GeoFactor {
  code: GeoFactorCode;
  weight: number;
  score: number;
}
export interface GeoFinding {
  code: string;
  severity: IssueSeverity;
  message: string;
  howToFix: string;
  evidence: string[];
}
export interface GeoResult {
  url: string;
  score: number;
  factors: GeoFactor[];
  findings: GeoFinding[];
}

// "X is …" definitions are the most directly quotable sentence shape.
const DEFINITION_RE =
  /\b[A-Z][^.!?]{2,80}?\s+(?:is|are|refers to)\s+(?:a|an|the)\b/;
// Specific figures beat vague claims for extractability.
const STAT_RE = /\b\d+(?:\.\d+)?\s*%|\b\d{4,}\b|\$\s?\d[\d,]*/g;
// Attributed claims survive an answer engine's sourcing pass.
const ATTRIBUTION_RE =
  /according to|reported by|cited (?:in|by)|study found|source:/gi;
// Headings mirroring how people phrase questions to AI surfaces.
const QUESTION_RE =
  /^(?:what|why|how|when|where|which|who|can|does|is|are)\b.*\?/i;
const BYLINE_RE = /^\s*by\s+[A-Z]/;
const REFERENCE_HOST_RE = /\.(?:edu|gov|mil)\b|wikipedia\.org/i;
const VIDEO_HOST_RE = /youtube\.com|youtu\.be|vimeo\.com/i;
// A bare framework mount means the server response carried no content.
const SHELL_MOUNT_RE =
  /<[a-z][a-z0-9-]*[^<>]*\sid\s*=\s*"(?:root|app|__next|__nuxt)"/i;
const STALE_DAYS = 180;

interface GeoMarkup {
  headings: Array<{ level: number; text: string }>;
  paragraphs: string[];
  listCount: number;
  tableCount: number;
  hasVideo: boolean;
  hasForm: boolean;
  authorMeta: string | null;
  publishedMeta: string | null;
  timeDatetimes: string[];
  hasRelAuthor: boolean;
}

// One tokenizer pass for the structure the streaming analyzer omits.
function extractMarkup(html: string): GeoMarkup {
  const m: GeoMarkup = {
    headings: [],
    paragraphs: [],
    listCount: 0,
    tableCount: 0,
    hasVideo: false,
    hasForm: false,
    authorMeta: null,
    publishedMeta: null,
    timeDatetimes: [],
    hasRelAuthor: false,
  };
  let heading: { level: number; parts: string[] } | null = null;
  let paragraph: string[] | null = null;
  const parser = new Parser({
    onopentag(name, attribs) {
      if (name === "ul" || name === "ol") m.listCount += 1;
      else if (name === "table") m.tableCount += 1;
      else if (name === "video") m.hasVideo = true;
      else if (name === "form") m.hasForm = true;
      else if (name === "meta" && attribs["name"] === "author")
        m.authorMeta ??= attribs["content"]?.trim() || null;
      else if (name === "time" && attribs["datetime"])
        m.timeDatetimes.push(attribs["datetime"]);
      else if (name === "link" && (attribs["rel"] ?? "").includes("author"))
        m.hasRelAuthor = true;
      if (name === "iframe" && VIDEO_HOST_RE.test(attribs["src"] ?? ""))
        m.hasVideo = true;
      const prop = attribs["property"] ?? "";
      if (name === "meta" && prop.endsWith("_time"))
        m.publishedMeta ??= attribs["content"]?.trim() || null;
      const level = /^h([1-6])$/.exec(name)?.[1];
      if (level) heading = { level: Number(level), parts: [] };
      else if (name === "p") paragraph = [];
    },
    ontext(text) {
      heading?.parts.push(text);
      paragraph?.push(text);
    },
    onclosetag(name) {
      if (heading && name === `h${heading.level}`) {
        const text = heading.parts.join("").replace(/\s+/g, " ").trim();
        if (text) m.headings.push({ level: heading.level, text });
        heading = null;
      } else if (paragraph && name === "p") {
        const text = paragraph.join("").replace(/\s+/g, " ").trim();
        if (text) m.paragraphs.push(text);
        paragraph = null;
      }
    },
  });
  parser.write(html);
  parser.end();
  return m;
}

// Minimal JSON-LD read: type and date/author presence for citability only.
interface MiniSchema {
  types: string[];
  dates: string[];
  hasAuthor: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function collectNode(item: Record<string, unknown>, out: MiniSchema): void {
  const rawType = item["@type"];
  if (typeof rawType === "string") out.types.push(rawType);
  for (const key of ["datePublished", "dateModified"]) {
    const date = item[key];
    if (typeof date === "string") out.dates.push(date);
  }
  if (item["author"] !== undefined) out.hasAuthor = true;
}

function extractMiniSchema(html: string): MiniSchema {
  const out: MiniSchema = { types: [], dates: [], hasAuthor: false };
  let buffer: string[] | null = null;
  const parser = new Parser({
    onopentag(name, attribs) {
      const type = (attribs["type"] ?? "").trim().toLowerCase();
      const jsonLd =
        name === "script" && type.startsWith("application/ld+json");
      if (buffer === null && jsonLd) buffer = [];
    },
    ontext(text) {
      buffer?.push(text);
    },
    onclosetag(name) {
      if (name !== "script" || buffer === null) return;
      const body = buffer.join("");
      buffer = null;
      let parsed: unknown;
      try {
        parsed = JSON.parse(body) as unknown;
      } catch {
        return; // Broken JSON-LD belongs to schema checks, not citability.
      }
      const roots = Array.isArray(parsed) ? parsed : [parsed];
      for (const root of roots) {
        if (!isRecord(root)) continue;
        const graph = root["@graph"];
        const nodes = Array.isArray(graph) ? graph : [root];
        for (const node of nodes) if (isRecord(node)) collectNode(node, out);
      }
    },
  });
  parser.write(html);
  parser.end();
  return out;
}

// Most recent valid date across <time>, article meta, and schema dates.
function newestDate(markup: GeoMarkup, schema: MiniSchema): Date | null {
  const candidates = [...markup.timeDatetimes, ...schema.dates];
  if (markup.publishedMeta) candidates.push(markup.publishedMeta);
  let newest: Date | null = null;
  for (const candidate of candidates) {
    const parsed = new Date(candidate);
    if (Number.isNaN(parsed.getTime())) continue;
    if (newest === null || parsed > newest) newest = parsed;
  }
  return newest;
}

function clampScore(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value)));
}

function wordsOf(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

interface FactorContext {
  analysis: PageAnalysis;
  markup: GeoMarkup;
  schema: MiniSchema;
  html: string;
  robotsSearchAllowed: boolean | null;
  findings: GeoFinding[];
}

type GeoCode =
  | "geo-no-text"
  | "geo-weak-opening"
  | "geo-thin-evidence"
  | "geo-headings"
  | "geo-no-question-headings"
  | "geo-no-lists-tables"
  | "geo-anonymous"
  | "geo-dates"
  | "geo-no-external-citations"
  | "geo-thin-server-html"
  | "geo-robots"
  | "geo-noindex-nosnippet"
  | "geo-no-multimodal"
  | "geo-llms-txt";

// Finding prose lives in one table so call sites stay one-liners.
const GEO_TEXT: Record<GeoCode, [IssueSeverity, string, string]> = {
  "geo-no-text": ["critical", "No text to quote.", "Serve content in HTML."],
  "geo-weak-opening": [
    "warning",
    "Opening lacks a quotable definition and answer.",
    "Open with “X is …”; answer in 40–60 words.",
  ],
  "geo-thin-evidence": [
    "warning",
    "Claims lack figures and named sources.",
    "Add numbers with “according to …”.",
  ],
  "geo-headings": ["warning", "Bad heading outline.", "One H1; H1 → H2 → H3."],
  "geo-no-question-headings": [
    "warning",
    "No heading mirrors buyer query phrasing.",
    "Rewrite two H2s as questions buyers ask.",
  ],
  "geo-no-lists-tables": ["info", "Prose hides steps.", "Use lists/tables."],
  "geo-anonymous": ["warning", "No author signal.", "Add a byline."],
  "geo-dates": [
    "warning",
    "Recency is unreadable, or the page is stale.",
    "Show dates; refresh facts on schedule.",
  ],
  "geo-no-external-citations": [
    "warning",
    "No outbound source is cited.",
    "Link claims to primary sources.",
  ],
  "geo-thin-server-html": [
    "warning",
    "Too little server text for plain-HTML crawlers.",
    "Server-render the main content.",
  ],
  "geo-robots": ["warning", "Crawler access unsure.", "Allow AI crawlers."],
  "geo-noindex-nosnippet": [
    "critical",
    "Robots meta opts the page out of answers.",
    "Remove noindex/nosnippet.",
  ],
  "geo-no-multimodal": ["info", "No rich media.", "Add image + alt text."],
  "geo-llms-txt": ["info", "No citation weight.", "No action needed."],
};

function flag(ctx: FactorContext, code: GeoCode, evidence: string[]): void {
  const [severity, message, howToFix] = GEO_TEXT[code];
  ctx.findings.push({ code, severity, message, howToFix, evidence });
}

// Criterion 1 (25%): engines lift blocks they can quote standalone, so
// definitions, front-loaded answers, figures, and sourced claims each earn
// a share. The 130-170 word block is a readability heuristic, not a rule —
// the 80-220 band avoids penalizing pages Google would still cite.
function scorePassages(ctx: FactorContext): number {
  const { analysis, markup } = ctx;
  if (!analysis.bodyText) {
    flag(ctx, "geo-no-text", ["0 visible words"]);
    return 0;
  }
  const text = analysis.bodyText;
  const head = text.slice(0, Math.ceil(text.length / 3));
  const defined = DEFINITION_RE.test(head) || DEFINITION_RE.test(text);
  const firstPara = wordsOf(markup.paragraphs[0] ?? "");
  let score = defined ? 25 : 0;
  if (firstPara >= 20) score += 15;
  if (!defined || firstPara < 20)
    flag(ctx, "geo-weak-opening", [`first paragraph: ${firstPara} words`]);
  const stats = (text.match(STAT_RE) ?? []).length;
  const cited = (text.match(ATTRIBUTION_RE) ?? []).length;
  score += Math.min(20, stats * 5) + Math.min(20, cited * 10);
  if (stats + cited === 0)
    flag(ctx, "geo-thin-evidence", [`${analysis.wordCount} words, none found`]);
  const blocks = markup.paragraphs.filter(
    (p) => wordsOf(p) >= 80 && wordsOf(p) <= 220,
  ).length;
  return clampScore(score + Math.min(20, blocks * 10));
}

// Criterion 2 (20%): extractors walk the heading tree, so a clean H1→H2→H3
// spine plus question headings and list/table structure decides whether the
// page parses into quotable chunks at all.
function scoreStructure(ctx: FactorContext): number {
  const { analysis, markup } = ctx;
  const order = analysis.headingOrder;
  const skipped = order.some((lv, i) => i > 0 && lv > order[i - 1] + 1);
  let score = 0;
  if (analysis.h1s.length === 1 && order.length > 0 && !skipped) score += 40;
  else flag(ctx, "geo-headings", [`${analysis.h1s.length} H1s`]);
  const questions = markup.headings.filter((h) => QUESTION_RE.test(h.text));
  score += Math.min(30, questions.length === 0 ? 0 : 15 + questions.length * 7);
  if (questions.length === 0)
    flag(
      ctx,
      "geo-no-question-headings",
      markup.headings.slice(0, 3).map((h) => h.text),
    );
  if (markup.listCount > 0) score += 20;
  if (markup.tableCount > 0) score += 10;
  if (markup.listCount + markup.tableCount === 0)
    flag(ctx, "geo-no-lists-tables", [
      `${markup.paragraphs.length} paragraphs`,
    ]);
  return clampScore(score);
}

// Criterion 3 (20%): attribution only counts when the engine can name who
// says it and when — author, dates, outbound citations, and organization
// schema are the on-page half of that trust.
function scoreAuthority(ctx: FactorContext): number {
  const { analysis, markup, schema } = ctx;
  let score = 0;
  const byline = markup.paragraphs.some((p) => BYLINE_RE.test(p));
  const named =
    markup.authorMeta || markup.hasRelAuthor || schema.hasAuthor || byline;
  if (named) score += 25;
  else flag(ctx, "geo-anonymous", ["no author signal"]);
  const newest = newestDate(markup, schema);
  const stale =
    newest !== null &&
    (Date.now() - newest.getTime()) / 86_400_000 > STALE_DAYS;
  if (newest && !stale) score += 25;
  else if (newest) score += 12;
  if (!newest) flag(ctx, "geo-dates", ["no machine-readable date"]);
  else if (stale)
    flag(ctx, "geo-dates", [`newest ${newest.toISOString().slice(0, 10)}`]);
  const external = analysis.links.filter((l) => !l.isInternal).length;
  score += external >= 3 ? 25 : external >= 1 ? 18 : 0;
  if (external === 0)
    flag(ctx, "geo-no-external-citations", ["0 external links"]);
  if (schema.types.includes("Organization")) score += 15;
  if (analysis.links.some((l) => REFERENCE_HOST_RE.test(l.targetUrl)))
    score += 10;
  return clampScore(score);
}

// Criterion 4 (20%): several AI crawlers read raw HTML without JavaScript
// while Googlebot renders, so content must already be in the server
// response; robots posture arrives as a parameter, never fetched.
function scoreTechnical(ctx: FactorContext): number {
  const { analysis, html, robotsSearchAllowed } = ctx;
  let score = 0;
  if (analysis.wordCount >= 150) score += 60;
  else if (analysis.wordCount >= 50) score += 30;
  else {
    score += 5;
    const shell = SHELL_MOUNT_RE.test(html) ? "app-shell" : "thin HTML";
    flag(ctx, "geo-thin-server-html", [`${analysis.wordCount} words`, shell]);
  }
  if (robotsSearchAllowed === true) score += 30;
  else if (robotsSearchAllowed === null) {
    score += 10;
    flag(ctx, "geo-robots", ["posture not supplied"]);
  } else flag(ctx, "geo-robots", ["search crawler disallowed"]);
  if (analysis.canonical) score += 10;
  const meta = (analysis.robotsMeta ?? "").toLowerCase();
  if (meta.includes("noindex") || meta.includes("nosnippet")) {
    flag(ctx, "geo-noindex-nosnippet", [analysis.robotsMeta ?? ""]);
    return Math.min(score, 20);
  }
  return clampScore(score);
}

// Criterion 5 (15%): supporting signal only — media gives engines something
// to show alongside the quote, never the quote itself.
function scoreMultimodal(ctx: FactorContext): number {
  const { analysis, markup, schema } = ctx;
  let score = 0;
  const withAlt = analysis.images.filter((img) => img.alt?.trim()).length;
  if (withAlt > 0) score += 30;
  if (markup.hasVideo) score += 25;
  if (markup.listCount > 0 || markup.tableCount > 0) score += 20;
  if (
    schema.types.includes("ImageObject") ||
    schema.types.includes("VideoObject")
  )
    score += 15;
  if (markup.hasForm) score += 10;
  if (withAlt === 0 && !markup.hasVideo)
    flag(ctx, "geo-no-multimodal", [
      `${analysis.images.length} images, 0 with alt`,
    ]);
  return clampScore(score);
}

// Score a page's AI-search citability from its server HTML. Crawler posture
// is accepted as parameters, never fetched.
export function scoreGeoCitability(input: GeoInput): GeoResult {
  const parsed = geoInputSchema.parse(input);
  const ctx: FactorContext = {
    analysis: analyzeHtml(parsed.html, parsed.url, 200, 0),
    markup: extractMarkup(parsed.html),
    schema: extractMiniSchema(parsed.html),
    html: parsed.html,
    robotsSearchAllowed: parsed.crawl?.robotsSearchAllowed ?? null,
    findings: [],
  };
  const factors: GeoFactor[] = [
    { code: "passages", weight: 0.25, score: scorePassages(ctx) },
    { code: "structure", weight: 0.2, score: scoreStructure(ctx) },
    { code: "authority", weight: 0.2, score: scoreAuthority(ctx) },
    { code: "technical", weight: 0.2, score: scoreTechnical(ctx) },
    { code: "multimodal", weight: 0.15, score: scoreMultimodal(ctx) },
  ];
  const llmsTxt = parsed.crawl?.llmsTxtPresent;
  if (llmsTxt !== undefined && llmsTxt !== null)
    flag(ctx, "geo-llms-txt", [`present: ${llmsTxt}`]);
  const score = Math.round(factors.reduce((s, f) => s + f.score * f.weight, 0));
  return { url: parsed.url, score, factors, findings: ctx.findings };
}
