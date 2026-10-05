import { describe, expect, it } from "vitest";
import {
  analyzeNlp,
  nlpInputSchema,
  readingLevel,
  stem,
  tokenizeWords,
} from "@/server/lib/audit/nlp-analyze";
import type {
  CoverageReport,
  EntityStat,
  KeywordDensityReport,
  NlpAnalysis,
  NlpInput,
  ReadingLevel,
  TermStat,
} from "@/server/lib/audit/nlp-analyze";

const VARIED_WORDS =
  "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu amber bronze copper crystal diamond emerald forest glacier harbor island jacket";

function run(input: NlpInput): NlpAnalysis {
  return analyzeNlp(input);
}

describe("tokenizeWords", () => {
  it("lowercases, keeps apostrophes, and drops numbers/symbols", () => {
    expect(tokenizeWords("The cat's meow, 42 times!")).toEqual([
      "the",
      "cat's",
      "meow",
      "times",
    ]);
  });

  it("returns an empty array for text with no latin words", () => {
    expect(tokenizeWords("日本語 の テキスト")).toEqual([]);
    expect(tokenizeWords("")).toEqual([]);
  });
});

describe("stem", () => {
  it("merges plural, -ing, and -ed variants", () => {
    expect(stem("rankings")).toBe("rank");
    expect(stem("ranking")).toBe("rank");
    expect(stem("ranked")).toBe("rank");
    expect(stem("tested")).toBe("test");
  });

  it("handles -ies and -sses word classes without mangling stems", () => {
    expect(stem("studies")).toBe("study");
    expect(stem("classes")).toBe("class");
    expect(stem("process")).toBe("process");
    expect(stem("services")).toBe("service");
  });
});

describe("readingLevel", () => {
  it("scores simple one-syllable sentences near the top of the scale", () => {
    const level: ReadingLevel = readingLevel("The cat sat on the mat.");
    expect(level.fleschReadingEase).toBe(100);
    expect(level.fleschKincaidGrade).toBe(0);
    expect(level.sentences).toBe(1);
    expect(level.averageSyllablesPerWord).toBe(1);
  });

  it("scores dense polysyllabic prose far below simple prose", () => {
    const easy = readingLevel("The cat sat on the mat. It was red.");
    const hard = readingLevel(
      "Photosynthesis transduces solar irradiance into chemical energy through elaborate biochemical pathways.",
    );
    expect(hard.fleschReadingEase).toBeLessThan(easy.fleschReadingEase);
    expect(hard.fleschKincaidGrade).toBeGreaterThan(easy.fleschKincaidGrade);
    expect(hard.fleschReadingEase).toBeLessThan(30);
  });

  it("returns zeros for empty input and counts unpunctuated text as one sentence", () => {
    expect(readingLevel("")).toMatchObject({
      fleschReadingEase: 0,
      fleschKincaidGrade: 0,
      sentences: 0,
    });
    expect(readingLevel("hello world").sentences).toBe(1);
  });
});

describe("analyzeNlp", () => {
  it("is deterministic across runs", () => {
    const input: NlpInput = {
      text: `${VARIED_WORDS}. Google Search reported results in 2025.`,
      title: "Field Notes",
      h1: "Field Notes",
    };
    expect(run(input)).toEqual(run(input));
  });

  it("groups stemmed variants under the most frequent surface form", () => {
    const analysis = run({ text: "rankings rankings ranking ranked." });
    const top: TermStat | undefined = analysis.terms[0];
    expect(top).toMatchObject({ term: "rankings", count: 4, density: 1 });
    expect(analysis.tokenCount).toBe(4);
    expect(analysis.uniqueTokenCount).toBe(3);
  });

  it("excludes stopwords from terms", () => {
    const analysis = run({ text: "the and of cat" });
    expect(analysis.terms).toHaveLength(1);
    expect(analysis.terms[0]?.term).toBe("cat");
    expect(analysis.terms[0]?.density).toBe(0.25);
  });

  it("extracts adjacent content-word key phrases and breaks on stopwords", () => {
    const phrases = run({
      text: "content marketing content marketing strategy",
    }).keyPhrases;
    expect(phrases[0]).toMatchObject({
      term: "content marketing",
      count: 2,
    });
    const broken = run({ text: "state of the art" }).keyPhrases;
    expect(broken).toEqual([]);
    expect(broken.map((phrase) => phrase.term)).not.toContain("of the");
  });

  it("extracts capitalized multi-word entities with salience", () => {
    const analysis = run({
      text: "Google Search expanded. New York Times covered Google Search again.",
    });
    const top: EntityStat | undefined = analysis.entities[0];
    expect(top).toEqual({ name: "Google Search", count: 2, salience: 0.2 });
    expect(analysis.entities.map((entity) => entity.name)).toContain(
      "New York Times",
    );
  });

  it("measures topical coverage of the title and H1 against the body", () => {
    const covered = run({
      text: "Advanced keyword research tactics, explained with examples.",
      title: "Advanced Keyword Research Tactics",
      h1: "Advanced Keyword Research Tactics",
    });
    expect(covered.coverage.titleCoverage).toBe(1);
    expect(covered.coverage.h1Coverage).toBe(1);
    expect(covered.coverage.missingFromBody).toEqual([]);

    const missing = run({
      text: "Plain prose about cooking recipes here.",
      title: "Quantum Blockchain Syntropy Guide",
    });
    const coverage: CoverageReport = missing.coverage;
    expect(coverage.titleCoverage).toBe(0);
    expect(coverage.missingFromBody).toContain("blockchain");
  });

  it("treats a missing title as vacuously covered", () => {
    const analysis = run({ text: "Body copy only." });
    expect(analysis.coverage.titleTerms).toEqual([]);
    expect(analysis.coverage.titleCoverage).toBe(1);
    expect(analysis.coverage.h1Coverage).toBe(1);
  });

  it("flags over-optimization when one term dominates the page", () => {
    const stuffed = run({
      text: `seo seo seo seo seo seo seo seo seo seo ${VARIED_WORDS}`,
    });
    const density: KeywordDensityReport = stuffed.density;
    expect(density.overOptimized).toBe(true);
    expect(density.flags.length).toBeGreaterThanOrEqual(1);
    expect(density.flags[0]).toContain("seo");
    expect(density.topTerm?.term).toBe("seo");
  });

  it("accepts a page with varied vocabulary", () => {
    const analysis = run({ text: VARIED_WORDS });
    const density: KeywordDensityReport = analysis.density;
    expect(density.overOptimized).toBe(false);
    expect(density.flags).toEqual([]);
    expect(density.topTerm?.density).toBeLessThanOrEqual(0.03);
  });

  it("returns an empty but well-formed analysis for empty text", () => {
    const analysis = run({ text: "" });
    expect(analysis.tokenCount).toBe(0);
    expect(analysis.terms).toEqual([]);
    expect(analysis.entities).toEqual([]);
    expect(analysis.density.topTerm).toBeNull();
    expect(analysis.density.overOptimized).toBe(false);
    expect(analysis.readingLevel.sentences).toBe(0);
  });

  it("surfaces reading level from the body text", () => {
    const analysis = run({ text: "The cat sat on the mat. It was red." });
    expect(analysis.readingLevel.fleschReadingEase).toBeGreaterThan(80);
    expect(analysis.readingLevel.sentences).toBe(2);
  });
});

describe("nlpInputSchema", () => {
  it("requires a string text field", () => {
    expect(nlpInputSchema.safeParse({ text: "ok" }).success).toBe(true);
    expect(nlpInputSchema.safeParse({ text: 7 }).success).toBe(false);
    expect(nlpInputSchema.safeParse({}).success).toBe(false);
  });
});
