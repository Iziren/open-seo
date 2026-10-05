import { describe, expect, it } from "vitest";
import {
  analyzeContentQuality,
  scoreText,
} from "@/server/lib/audit/content-quality";
import type {
  ContentQualityResult,
  QualityDimensions,
  QualityFlag,
  TextCoverageNote,
  TextQualitySignals,
} from "@/server/lib/audit/content-quality";
import type { PageAnalysis, PageLink } from "@/server/lib/audit/types";

function makeAnalysis(overrides: Partial<PageAnalysis> = {}): PageAnalysis {
  return {
    url: "https://example.com/guide",
    statusCode: 200,
    redirectUrl: null,
    responseTimeMs: 100,
    title: "A Guide to Marathon Training",
    metaDescription: "",
    canonical: null,
    robotsMeta: null,
    ogTitle: null,
    ogDescription: null,
    ogImage: null,
    h1s: ["A Guide to Marathon Training"],
    headingOrder: [1],
    wordCount: 0,
    bodyText: "",
    images: [],
    links: [],
    hasStructuredData: false,
    hreflangTags: [],
    ...overrides,
  };
}

function link(targetUrl: string, isInternal: boolean): PageLink {
  return { targetUrl, anchor: "See more", isInternal, isNofollow: false };
}

const HEALTHY_SENTENCES = [
  "We tested 8 marathon training plans over 12 weeks in Portland with runners of every pace, age, and injury history.",
  "Our coaches measured heart rate, pace, cadence, and sleep quality for each athlete every single morning of the study.",
  "47% of runners reported fewer aches after switching to the easy-pace plan we recommended in week 3 of training.",
  "The average finish time improved by 6 minutes per runner, according to a Stanford study on running economy in 2025.",
  "In 2025 we rebuilt the training workbook so every block now includes strength work, mobility drills, and clear pacing advice.",
  "This page was updated in 2025 with fresh split times and new injury-prevention guidance from our coaching staff.",
  "Specialist physiotherapists reviewed the injury chapter, and a certified running expert approved every progression chart in the guide.",
  "Beginners should start conservatively because aerobic adaptations take months, and rushing mileage is the most common mistake we see.",
  "Marathon fueling works best when practiced during long runs, since the gut adapts to carbohydrate intake over several weeks.",
  "The plan includes easy runs, tempo sessions, interval work, long runs, and recovery days arranged in a sensible weekly sequence.",
  "Data shows that runners who slept at least 8 hours improved threshold pace more than sleep-deprived runners did over time.",
  "We compared the plan with two commercial training apps and found their workouts less specific for first-time marathoners everywhere.",
  "Strength training twice weekly reduces common overuse injuries, and our team includes a 20-minute routine for busy people.",
  "Heat acclimation matters for autumn races, so we recommend short midday runs in the weeks before a warm marathon.",
  "Every paces table uses heart rate zones rather than vague effort words, which keeps easy days genuinely easy for everyone.",
  "Readers who want the printable version can download the full 16-week workbook with every session, chart, and coaching note.",
  "We also surveyed 320 readers about which plans felt sustainable after the first month of daily use.",
];

const HEALTHY_BODY = HEALTHY_SENTENCES.join(" ");

const HEALTHY_LINKS = [
  link("https://www.nytimes.com/running", false),
  link("https://stanford.edu/study", false),
  link("https://en.wikipedia.org/wiki/Marathon", false),
  link("https://www.runnersworld.com/plan", false),
  link("https://www.trainingpeaks.com/tool", false),
  link("https://example.com/plan", true),
  link("https://example.com/pricing", true),
  link("https://example.com/about", true),
];

const SPAM_UNIT =
  "When it comes to SEO, needless to say, at the end of the day it goes without saying. Let's dive into the in the ever-evolving landscape, moreover, furthermore, cutting-edge results.";
const SPAM_BODY = Array.from({ length: 4 }, () => SPAM_UNIT).join(" ");

function healthyResult(): ContentQualityResult {
  return analyzeContentQuality(
    makeAnalysis({
      metaDescription:
        "Evidence-based marathon training plans, tested for 12 weeks.",
      canonical: "https://example.com/guide",
      hasStructuredData: true,
      headingOrder: [1, 2, 2, 2, 3, 3],
      bodyText: HEALTHY_BODY,
      images: [{ src: "/runners.png", alt: "Runner on a forest trail" }],
      links: HEALTHY_LINKS,
    }),
  );
}

describe("scoreText (content_quality.py port)", () => {
  it("returns the empty-input result for blank text", () => {
    const signals: TextQualitySignals = scoreText("   ");
    const flags: QualityFlag[] = signals.flags;
    expect(flags).toEqual(["empty-input"]);
    expect(signals.tokens).toBe(0);
    expect(signals.matches).toEqual({ filler: [], aiPatterns: [] });
    expect(signals.coverage).toBeUndefined();
  });

  it("scores filler phrases and flags them", () => {
    const signals = scoreText(
      "When it comes to SEO. Needless to say, at the end of the day. First and foremost, the bottom line is this.",
    );
    expect(signals.flags).toContain("filler");
    expect(signals.matches.filler).toContain("needless to say");
    expect(signals.fillerScore).toBeGreaterThanOrEqual(50);
  });

  it("scores AI-typical phrasings and flags them", () => {
    const signals = scoreText(
      "We delve into the ever-changing landscape, moreover, cutting-edge tools.",
    );
    expect(signals.flags).toContain("ai-patterns");
    expect(signals.matches.aiPatterns).toContain("delve into");
    expect(signals.aiPatternScore).toBeGreaterThanOrEqual(40);
  });

  it("flags repeated bigrams as repetitive", () => {
    const signals = scoreText(
      "search engine search engine search engine search engine",
    );
    expect(signals.repetitionScore).toBe(100);
    expect(signals.flags).toContain("repetitive");
  });

  it("measures information density from entities and numbers", () => {
    const signals = scoreText(
      "Acme Corp shipped 1500 units to Zenith Industries in 2025.",
    );
    expect(signals.informationDensity).toBe(1);
    expect(signals.flags).not.toContain("low-density");
  });

  it("flags short text as thin", () => {
    expect(scoreText("one two three").flags).toContain("thin-content");
  });

  it("tokenizes CJK text per character and reports English-only coverage", () => {
    const signals = scoreText("日本語のテキストです。これはテストです。");
    expect(signals.tokens).toBeGreaterThan(10);
    const coverage: TextCoverageNote | undefined = signals.coverage;
    expect(coverage).toEqual({
      script: "cjk",
      entityDensity: "not_computed",
      phraseLists: "english_only",
    });
  });
});

describe("analyzeContentQuality", () => {
  it("scores a healthy page well with high trust and no trust finding", () => {
    const result = healthyResult();
    const dimensions: QualityDimensions = result.dimensions;
    expect(result.overall).toBeGreaterThanOrEqual(70);
    expect(result.overall).toBeLessThanOrEqual(100);
    for (const [name, value] of Object.entries(dimensions)) {
      expect(value, name).toBeGreaterThanOrEqual(0);
      expect(value, name).toBeLessThanOrEqual(100);
    }
    expect(dimensions.trust).toBeGreaterThanOrEqual(90);
    expect(dimensions.authority).toBeGreaterThanOrEqual(90);
    expect(dimensions.experience).toBeGreaterThanOrEqual(80);
    expect(result.flags).not.toContain("filler");
    expect(result.flags).not.toContain("ai-patterns");
    expect(result.tokens).toBeGreaterThanOrEqual(300);
    const codes = result.findings.map((finding) => finding.code);
    expect(codes).not.toContain("weak-trust-signals");
    expect(codes).not.toContain("thin-text");
    expect(codes).not.toContain("empty-text");
    expect(codes).not.toContain("filler-content");
  });

  it("scores a filler-heavy, unlinked page far lower", () => {
    const spam = analyzeContentQuality(
      makeAnalysis({
        url: "http://example.com/bad",
        metaDescription: "",
        bodyText: SPAM_BODY,
        headingOrder: [1],
      }),
    );
    const healthy = healthyResult();
    expect(spam.overall).toBeLessThan(healthy.overall);
    expect(spam.overall).toBeLessThan(40);
    expect(spam.flags).toEqual([
      "filler",
      "ai-patterns",
      "low-density",
      "repetitive",
      "thin-content",
    ]);
    const codes = spam.findings.map((finding) => finding.code);
    expect(codes).toContain("filler-content");
    expect(codes).toContain("ai-pattern-signal");
    expect(codes).toContain("thin-text");
    expect(codes).toContain("weak-trust-signals");
  });

  it("weights trust: secure, described, structured pages score much higher", () => {
    const secure = analyzeContentQuality(
      makeAnalysis({
        canonical: "https://example.com/guide",
        hasStructuredData: true,
        metaDescription: "A tested guide with sources and structured data.",
        links: [link("https://external.example/reference", false)],
      }),
    );
    const plain = analyzeContentQuality(
      makeAnalysis({ url: "http://insecure.example/x" }),
    );
    expect(
      secure.dimensions.trust - plain.dimensions.trust,
    ).toBeGreaterThanOrEqual(70);
  });

  it("reports the empty-text finding for a page with no body copy", () => {
    const result = analyzeContentQuality(makeAnalysis({ bodyText: "" }));
    expect(result.findings[0]?.code).toBe("empty-text");
    expect(result.flags).toEqual(["empty-input"]);
    expect(result.overall).toBeGreaterThanOrEqual(0);
    expect(result.overall).toBeLessThanOrEqual(100);
  });

  it("flags hard-to-read dense prose", () => {
    const words = [
      "Photosynthesis",
      "transduces",
      "electromagnetic",
      "radiation",
      "constituents",
      "chemical",
      "energy",
      "elaborate",
      "biochemical",
      "pathways",
      "continuously",
      "regenerating",
      "carbon",
      "compounds",
      "extraordinarily",
      "efficiently",
      "nevertheless",
      "consequently",
      "infrastructure",
      "reorganization",
      "reconfiguration",
      "unquestionably",
      "methodologically",
      "interconnected",
      "characteristically",
      "simultaneously",
      "fundamentally",
      "incomprehensibly",
      "photosynthetic",
      "interdependence",
    ];
    const result = analyzeContentQuality(
      makeAnalysis({ bodyText: `${words.join(" ")}.` }),
    );
    const codes = result.findings.map((finding) => finding.code);
    expect(codes).toContain("hard-to-read");
  });

  it("surfaces the CJK coverage caveat as a finding", () => {
    const result = analyzeContentQuality(
      makeAnalysis({
        bodyText: "日本語のページです。これはテストの文章です。",
      }),
    );
    expect(result.coverage?.script).toBe("cjk");
    expect(result.findings.map((finding) => finding.code)).toContain(
      "cjk-coverage-limited",
    );
  });

  it("emits well-formed findings", () => {
    const result = healthyResult();
    const spam = analyzeContentQuality(makeAnalysis({ bodyText: SPAM_BODY }));
    for (const finding of [...result.findings, ...spam.findings]) {
      expect(finding.code).toBeTruthy();
      expect(["critical", "warning", "info"]).toContain(finding.severity);
      expect(finding.message.length).toBeGreaterThan(10);
      expect(finding.howToFix.length).toBeGreaterThan(10);
      expect(Array.isArray(finding.evidence)).toBe(true);
    }
  });

  it("is deterministic", () => {
    expect(healthyResult()).toEqual(healthyResult());
  });
});
