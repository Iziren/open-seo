/**
 * Deterministic, dependency-free NLP analysis for page copy.
 *
 * nlp_analyze.py delegated entities/sentiment/classification to the Google
 * Cloud Natural Language API. That is not portable as-is: audit scoring must
 * be deterministic (same page → same score) and the analysis path cannot
 * make network calls, so entity/salience extraction is reimplemented locally
 * as tokenize → light-stem → count, and a Flesch reading-level signal
 * replaces sentiment as the text-quality measure. Sentiment, content
 * classification, and moderation were skipped entirely: they need a model or
 * an API and would make results non-reproducible. Local "salience" is an
 * entity's share of all tokens, which ranks entities like the API's does.
 */
import { sort } from "remeda";
import { z } from "zod";

export interface TermStat {
  /** Surface form (most frequent variant) of a stemmed content word. */
  term: string;
  count: number;
  /** count / total tokens, 0..1. */
  density: number;
}

export interface EntityStat {
  /** Capitalized multi-word run, e.g. "New York Times". */
  name: string;
  count: number;
  /** count / total tokens, 0..1 — local stand-in for API salience. */
  salience: number;
}

export interface CoverageReport {
  /** Stemmed content words of the title / H1 (deduped, in order). */
  titleTerms: string[];
  h1Terms: string[];
  /** Share of title content words present in the body, 0..1. 1 if no title. */
  titleCoverage: number;
  h1Coverage: number;
  /** Title/H1 content words absent from the body, deduped. */
  missingFromBody: string[];
}

export interface KeywordDensityReport {
  topTerm: TermStat | null;
  overOptimized: boolean;
  /** Human-readable reasons, empty when density is healthy. */
  flags: string[];
}

export interface ReadingLevel {
  fleschReadingEase: number;
  fleschKincaidGrade: number;
  averageSentenceLength: number;
  averageSyllablesPerWord: number;
  sentences: number;
}

export interface NlpAnalysis {
  tokenCount: number;
  uniqueTokenCount: number;
  /** Top content words by frequency, stemmed and stopword-filtered. */
  terms: TermStat[];
  /** Top adjacent content-word bigrams (surfaces, not stemmed). */
  keyPhrases: TermStat[];
  entities: EntityStat[];
  coverage: CoverageReport;
  density: KeywordDensityReport;
  readingLevel: ReadingLevel;
}

// Exported so callers (MCP tools) can validate raw input before calling —
// these modules sit on an untrusted-input boundary.
export const nlpInputSchema = z.object({
  text: z.string(),
  title: z.string().optional(),
  h1: z.string().optional(),
});

export type NlpInput = z.input<typeof nlpInputSchema>;

/** English-only analysis; CJK text yields no terms (tokenized away). */
const STOP_WORDS = new Set(
  "the|be|to|of|and|a|in|that|have|i|it|for|not|on|with|he|as|you|do|at|this|but|his|by|from|they|we|say|her|she|or|an|will|my|one|all|would|there|their|what|so|up|out|if|about|who|get|which|go|me|when|make|can|like|time|no|just|him|know|take|people|into|year|your|good|some|could|them|see|other|than|then|now|look|only|come|its|over|think|also|back|after|use|two|how|our|work|first|well|way|even|new|want|because|any|these|give|day|most|us|is|are|was|were|been|being|has|had|did|does|am|may|should|must|very|too|each|few|more|such|don|it's|we're|you're|i'm|that's|can't|won't|isn't|aren't|wasn't|weren't".split(
    "|",
  ),
);

const ENTITY_RE = /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g;
const TOP_TERMS_LIMIT = 25;
const TOP_PHRASES_LIMIT = 15;
const TOP_ENTITIES_LIMIT = 20;
const SINGLE_TERM_DENSITY_MAX = 0.03;
const TOP_FIVE_DENSITY_MAX = 0.15;

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

export function tokenizeWords(text: string): string[] {
  return text.toLowerCase().match(/[a-z][a-z']*/g) ?? [];
}

/**
 * Light rule-based stemmer (suffix stripping), not full Porter: enough to
 * merge "rankings"/"ranking"/"ranked" for counting while staying a dozen
 * lines of deterministic code.
 */
export function stem(word: string): string {
  let w = word;
  if (w.length > 4 && w.endsWith("ies")) w = `${w.slice(0, -3)}y`;
  else if (w.length > 4 && w.endsWith("sses")) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith("s") && !/(?:ss|us|is)$/.test(w))
    w = w.slice(0, -1);
  if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.length > 5 && w.endsWith("ed")) w = w.slice(0, -2);
  if (w.length > 4 && w.endsWith("ly")) w = w.slice(0, -2);
  return w;
}

/** Syllables via vowel-group heuristic — the standard readability proxy. */
function countSyllables(word: string): number {
  const cleaned = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!cleaned) return 0;
  if (cleaned.length <= 3) return 1;
  const groups = cleaned.match(/[aeiouy]+/g)?.length ?? 1;
  const silentE =
    cleaned.endsWith("e") && !/[aeiouy]e[^aeiouy]$/.test(cleaned) ? 1 : 0;
  return Math.max(1, groups - silentE);
}

/** Flesch Reading Ease + Flesch–Kincaid grade for English prose. */
export function readingLevel(text: string): ReadingLevel {
  const words = text.match(/[A-Za-z0-9'’-]+/g) ?? [];
  const chunks = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [];
  const sentences = chunks.filter((chunk) => /\S/.test(chunk)).length;
  if (words.length === 0 || sentences === 0) {
    return {
      fleschReadingEase: 0,
      fleschKincaidGrade: 0,
      averageSentenceLength: 0,
      averageSyllablesPerWord: 0,
      sentences,
    };
  }
  const syllables = words.reduce((sum, w) => sum + countSyllables(w), 0);
  const avgSentenceLength = words.length / sentences;
  const avgSyllables = syllables / words.length;
  const ease = 206.835 - 1.015 * avgSentenceLength - 84.6 * avgSyllables;
  const grade = 0.39 * avgSentenceLength + 11.8 * avgSyllables - 15.59;
  return {
    fleschReadingEase: round(Math.min(100, Math.max(0, ease)), 1),
    fleschKincaidGrade: round(Math.max(0, grade), 1),
    averageSentenceLength: round(avgSentenceLength, 1),
    averageSyllablesPerWord: round(avgSyllables, 2),
    sentences,
  };
}

function isContentWord(token: string): boolean {
  return token.length >= 2 && !STOP_WORDS.has(token);
}

/** Group tokens by stem; keep the most frequent surface form for display. */
function topTerms(tokens: string[], limit: number): TermStat[] {
  const byStem = new Map<
    string,
    { count: number; surfaces: Map<string, number> }
  >();
  for (const token of tokens) {
    if (!isContentWord(token)) continue;
    const key = stem(token);
    const entry = byStem.get(key) ?? { count: 0, surfaces: new Map() };
    entry.count += 1;
    entry.surfaces.set(token, (entry.surfaces.get(token) ?? 0) + 1);
    byStem.set(key, entry);
  }
  const total = Math.max(1, tokens.length);
  const stats: TermStat[] = [];
  for (const [key, entry] of byStem) {
    let surface = key;
    let best = 0;
    for (const [form, count] of entry.surfaces) {
      if (count > best) {
        surface = form;
        best = count;
      }
    }
    stats.push({
      term: surface,
      count: entry.count,
      density: round(entry.count / total, 4),
    });
  }
  // Stable sort keeps first-occurrence order for ties → deterministic output.
  return sort(stats, (a, b) => b.count - a.count).slice(0, limit);
}

function topKeyPhrases(tokens: string[], limit: number): TermStat[] {
  const counts = new Map<string, number>();
  let previous = "";
  for (const token of tokens) {
    // A stopword breaks the chain so phrases never embed function words.
    if (!isContentWord(token)) {
      previous = "";
      continue;
    }
    if (previous) {
      const phrase = `${previous} ${token}`;
      counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
    }
    previous = token;
  }
  const total = Math.max(1, tokens.length);
  const stats: TermStat[] = [];
  for (const [phrase, count] of counts) {
    stats.push({
      term: phrase,
      count,
      density: round(count / total, 4),
    });
  }
  return sort(stats, (a, b) => b.count - a.count).slice(0, limit);
}

function extractEntities(text: string, tokenCount: number): EntityStat[] {
  const counts = new Map<string, number>();
  for (const match of text.matchAll(ENTITY_RE)) {
    const name = match[0];
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const total = Math.max(1, tokenCount);
  const stats: EntityStat[] = [];
  for (const [name, count] of counts) {
    stats.push({ name, count, salience: round(count / total, 4) });
  }
  return sort(stats, (a, b) => b.count - a.count).slice(0, TOP_ENTITIES_LIMIT);
}

function stemmedContentWords(value: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of tokenizeWords(value)) {
    if (!isContentWord(token)) continue;
    const key = stem(token);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  }
  return out;
}

function coverageOf(
  value: string,
  bodyStems: Set<string>,
): { terms: string[]; ratio: number; missing: string[] } {
  const terms = stemmedContentWords(value);
  // Vacuous coverage when there is no title/H1 — "missing title" is a
  // separate concern; here nothing was expected to be covered.
  if (terms.length === 0) return { terms, ratio: 1, missing: [] };
  const missing = terms.filter((term) => !bodyStems.has(term));
  return {
    terms,
    ratio: round((terms.length - missing.length) / terms.length, 4),
    missing,
  };
}

function keywordDensity(terms: TermStat[]): KeywordDensityReport {
  const topTerm = terms[0] ?? null;
  const flags: string[] = [];
  if (topTerm && topTerm.density > SINGLE_TERM_DENSITY_MAX) {
    flags.push(
      `"${topTerm.term}" fills ${(topTerm.density * 100).toFixed(1)}% of tokens (healthy max ${SINGLE_TERM_DENSITY_MAX * 100}%)`,
    );
  }
  const topFive = terms.slice(0, 5);
  const combined = topFive.reduce((sum, term) => sum + term.density, 0);
  if (combined > TOP_FIVE_DENSITY_MAX) {
    flags.push(
      `top 5 terms fill ${(combined * 100).toFixed(1)}% of tokens (healthy max ${TOP_FIVE_DENSITY_MAX * 100}%)`,
    );
  }
  return { topTerm, overOptimized: flags.length > 0, flags };
}

/**
 * Analyze a page's text: keywords, noun-phrase entities, topical coverage
 * against the title/H1, keyword-density over-optimization, and reading
 * level. Input is Zod-parsed because MCP tools pass raw strings in.
 */
export function analyzeNlp(input: NlpInput): NlpAnalysis {
  const { text, title = "", h1 = "" } = nlpInputSchema.parse(input);
  const tokens = tokenizeWords(text);
  const terms = topTerms(tokens, TOP_TERMS_LIMIT);
  const bodyStems = new Set(
    tokens.filter(isContentWord).map((token) => stem(token)),
  );
  const titleCoverage = coverageOf(title, bodyStems);
  const h1Coverage = coverageOf(h1, bodyStems);
  const missingFromBody = [
    ...new Set([...titleCoverage.missing, ...h1Coverage.missing]),
  ];

  return {
    tokenCount: tokens.length,
    uniqueTokenCount: new Set(tokens).size,
    terms,
    keyPhrases: topKeyPhrases(tokens, TOP_PHRASES_LIMIT),
    entities: extractEntities(text, tokens.length),
    coverage: {
      titleTerms: titleCoverage.terms,
      h1Terms: h1Coverage.terms,
      titleCoverage: titleCoverage.ratio,
      h1Coverage: h1Coverage.ratio,
      missingFromBody,
    },
    density: keywordDensity(terms),
    readingLevel: readingLevel(text),
  };
}
