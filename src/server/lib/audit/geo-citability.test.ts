import { describe, expect, it } from "vitest";
import {
  geoInputSchema,
  scoreGeoCitability,
  type GeoFactorCode,
  type GeoInput,
  type GeoResult,
} from "@/server/lib/audit/geo-citability";

const URL = "https://example.com/what-is-sourdough";

interface CrawlSignals {
  robotsSearchAllowed?: boolean | null;
  llmsTxtPresent?: boolean | null;
}

function richHtml(): string {
  const intro = `Sourdough is a bread made with a live culture. ${"It rises slowly and keeps well. ".repeat(30)}`;
  const stats = `According to the Bread Institute, sales rose 47% in 2024 across 12000 bakers. ${"Fermentation takes patience. ".repeat(28)}`;
  const recent = new Date(Date.now() - 10 * 86_400_000).toISOString();
  return `<!doctype html><html><head>
<title>What is sourdough? A complete guide</title>
<meta name="description" content="A complete guide to sourdough bread.">
<meta name="author" content="Jane Baker">
<meta property="article:published_time" content="${recent}">
<link rel="canonical" href="${URL}">
<link rel="author" href="https://example.com/authors/jane">
</head><body>
<h1>What is sourdough?</h1>
<p>${intro}</p>
<h2>What is sourdough starter?</h2>
<p>A starter is a colony of wild yeast and bacteria. ${"Feed it daily for best results. ".repeat(24)}</p>
<h2>How do you bake sourdough?</h2>
<ol><li>Mix flour and water</li><li>Fold the dough</li><li>Bake hot</li></ol>
<p>${stats}</p>
<h2>Sourdough vs yeast bread</h2>
<table><tr><th>Bread</th><th>Rise</th></tr><tr><td>Sourdough</td><td>12 hours</td></tr></table>
<p>By Dr. Jane Baker. See the <a href="https://bread-institute.edu/study">study</a>.</p>
<time datetime="${recent}">Updated recently</time>
<img src="/loaf.jpg" alt="A scored sourdough loaf">
<iframe src="https://www.youtube.com/embed/abc123"></iframe>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","author":{"@type":"Person","name":"J. Baker"},"datePublished":"${recent}"}</script>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Example Bakery"}</script>
</body></html>`;
}

function score(html: string, crawl?: CrawlSignals): GeoResult {
  return scoreGeoCitability({ html, url: URL, ...(crawl ? { crawl } : {}) });
}

function factor(result: GeoResult, code: string): number {
  return result.factors.find((item) => item.code === code)?.score ?? -1;
}

function codes(result: GeoResult): string[] {
  return result.findings.map((finding) => finding.code);
}

describe("scoreGeoCitability", () => {
  it("scores a citable page highly with weighted sub-scores", () => {
    const result = score(richHtml(), { robotsSearchAllowed: true });
    expect(result.url).toBe(URL);
    expect(result.score).toBeGreaterThan(70);
    expect(result.factors).toHaveLength(5);
    const weights = Object.fromEntries(
      result.factors.map((f) => [f.code, f.weight]),
    );
    expect(weights).toMatchObject({
      passages: 0.25,
      structure: 0.2,
      authority: 0.2,
      technical: 0.2,
      multimodal: 0.15,
    });
    expect(factor(result, "passages")).toBeGreaterThanOrEqual(60);
    expect(factor(result, "structure")).toBeGreaterThanOrEqual(60);
  });

  it("penalizes anonymous, undated, uncited pages", () => {
    const html = `<html><head><title>Tips</title></head><body><h1>Baking tips</h1>
<p>${"Baking is wonderful and fun for everyone. ".repeat(40)}</p></body></html>`;
    const result = score(html, { robotsSearchAllowed: true });
    expect(result.score).toBeLessThan(55);
    expect(codes(result)).toContain("geo-anonymous");
    expect(codes(result)).toContain("geo-dates");
    expect(codes(result)).toContain("geo-no-external-citations");
  });

  it("flags JS shells and empty pages without throwing", () => {
    const shell = `<html><head><title>App</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>`;
    const shellResult = score(shell);
    expect(shellResult.score).toBeLessThan(40);
    expect(codes(shellResult)).toContain("geo-thin-server-html");
    const empty = score("");
    expect(empty.score).toBeLessThan(20);
    expect(codes(empty)).toContain("geo-no-text");
    expect(empty.findings[0].severity).toBe("critical");
  });

  it("handles missing JSON-LD and malformed HTML deterministically", () => {
    const malformed = `<html><head><title>Broken<h1>Oops<p>${"Some content here. ".repeat(30)}<div><p>Unclosed`;
    expect(score(malformed, { robotsSearchAllowed: true })).toEqual(
      score(malformed, { robotsSearchAllowed: true }),
    );
  });

  it("treats blocked search crawlers and noindex as citability blockers", () => {
    const blocked = score(richHtml(), { robotsSearchAllowed: false });
    expect(codes(blocked)).toContain("geo-robots");
    expect(blocked.score).toBeLessThan(
      score(richHtml(), { robotsSearchAllowed: true }).score,
    );
    const noindexed = `<html><head><title>T</title><meta name="robots" content="noindex"></head>
<body><h1>T</h1><p>${"Content words here. ".repeat(60)}</p></body></html>`;
    const noindexResult = score(noindexed, { robotsSearchAllowed: true });
    expect(codes(noindexResult)).toContain("geo-noindex-nosnippet");
    expect(factor(noindexResult, "technical")).toBeLessThanOrEqual(20);
  });

  it("reports llms.txt without changing the score", () => {
    const args = { robotsSearchAllowed: true } as const;
    const withFile = score(richHtml(), { ...args, llmsTxtPresent: true });
    const withoutFile = score(richHtml(), { ...args, llmsTxtPresent: false });
    expect(withFile.score).toBe(withoutFile.score);
    expect(
      withFile.findings.filter((f) => f.code === "geo-llms-txt"),
    ).toHaveLength(1);
  });

  it("flags stale content past the six-month recency window", () => {
    const old = new Date(Date.now() - 400 * 86_400_000).toISOString();
    const html = `<html><head><title>Guide</title><meta name="author" content="Sam"></head><body>
<h1>Guide</h1><p>${"Useful timeless advice for readers. ".repeat(40)}</p>
<time datetime="${old}">Published a while ago</time></body></html>`;
    expect(codes(score(html, { robotsSearchAllowed: true }))).toContain(
      "geo-dates",
    );
  });

  it("rejects invalid input through the Zod boundary", () => {
    expect(() => scoreGeoCitability({ html: "x", url: "" })).toThrow();
  });
});

describe("geo input contract", () => {
  it("parses valid input through the exported schema", () => {
    const input: GeoInput = { html: "<p>hi</p>", url: URL };
    expect(geoInputSchema.parse(input)).toMatchObject({ url: URL });
  });

  it("rejects empty urls through the exported schema", () => {
    expect(() =>
      geoInputSchema.parse({ html: "<p>hi</p>", url: "" }),
    ).toThrow();
  });

  it("emits the five documented factor codes", () => {
    const expected: GeoFactorCode[] = [
      "passages",
      "structure",
      "authority",
      "technical",
      "multimodal",
    ];
    expect(
      score(richHtml(), { robotsSearchAllowed: true }).factors.map(
        (f) => f.code,
      ),
    ).toEqual(expected);
  });
});
