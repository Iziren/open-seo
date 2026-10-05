import { describe, expect, it } from "vitest";
import {
  canonicalizeJson,
  collapseWhitespace,
  normalizeCanonicalUrl,
  similarityRatio,
  textEqualsIgnoringTruncation,
} from "./driftNormalize";

describe("collapseWhitespace", () => {
  it("collapses runs of whitespace and trims", () => {
    expect(collapseWhitespace("  The   Quick \n Brown  ")).toBe(
      "The Quick Brown",
    );
  });
});

describe("textEqualsIgnoringTruncation", () => {
  it("treats identical text as equal", () => {
    expect(textEqualsIgnoringTruncation("Same", "Same", 60)).toBe(true);
  });

  it("ignores a pure prefix cut at the truncation length", () => {
    const full =
      "The Ultimate Guide to Ranking Higher in Search Results for 2026";
    expect(full.length).toBeGreaterThanOrEqual(60);
    expect(textEqualsIgnoringTruncation(full, full.slice(0, 45), 60)).toBe(
      true,
    );
  });

  it("flags a prefix cut below the truncation length", () => {
    const full = "Short title that ends early";
    expect(textEqualsIgnoringTruncation(full, "Short title", 60)).toBe(false);
  });

  it("flags divergent text", () => {
    expect(
      textEqualsIgnoringTruncation(
        "Acme Tools for Professionals",
        "Acme Shoes for Runners",
        60,
      ),
    ).toBe(false);
  });

  it("never treats an empty side as a truncation match", () => {
    expect(textEqualsIgnoringTruncation("", "Something long", 10)).toBe(false);
  });
});

describe("normalizeCanonicalUrl", () => {
  it("returns null for absent input", () => {
    expect(normalizeCanonicalUrl(null)).toBeNull();
    expect(normalizeCanonicalUrl("   ")).toBeNull();
  });

  it("equates http and https", () => {
    expect(normalizeCanonicalUrl("http://example.com/page")).toBe(
      normalizeCanonicalUrl("https://example.com/page"),
    );
  });

  it("equates www and apex hosts", () => {
    expect(normalizeCanonicalUrl("https://www.example.com/page")).toBe(
      normalizeCanonicalUrl("https://example.com/page"),
    );
  });

  it("equates trailing-slash variants but not the root form", () => {
    expect(normalizeCanonicalUrl("https://example.com/page/")).toBe(
      normalizeCanonicalUrl("https://example.com/page"),
    );
    expect(normalizeCanonicalUrl("https://example.com")).toBe(
      normalizeCanonicalUrl("https://example.com/"),
    );
  });

  it("ignores host case, fragments, default ports, and query order", () => {
    expect(normalizeCanonicalUrl("https://EXAMPLE.com/a#x")).toBe(
      normalizeCanonicalUrl("https://example.com/a"),
    );
    expect(normalizeCanonicalUrl("https://example.com:443/a")).toBe(
      normalizeCanonicalUrl("https://example.com/a"),
    );
    expect(normalizeCanonicalUrl("https://example.com/a?b=2&a=1")).toBe(
      normalizeCanonicalUrl("https://example.com/a?a=1&b=2"),
    );
  });

  it("keeps genuinely different targets distinct", () => {
    expect(normalizeCanonicalUrl("https://example.com/a")).not.toBe(
      normalizeCanonicalUrl("https://example.com/b"),
    );
    expect(normalizeCanonicalUrl("https://example.com/a?page=2")).not.toBe(
      normalizeCanonicalUrl("https://example.com/a?page=3"),
    );
  });

  it("falls back to lowercased raw text for relative or malformed URLs", () => {
    expect(normalizeCanonicalUrl("/About/")).toBe("/about/");
    expect(normalizeCanonicalUrl("not a url")).toBe("not a url");
  });
});

describe("canonicalizeJson", () => {
  it("is insensitive to object key order, including nested", () => {
    expect(
      canonicalizeJson({ b: 1, a: { d: 2, c: [1, { z: 0, y: 1 }] } }),
    ).toBe(canonicalizeJson({ a: { c: [1, { y: 1, z: 0 }], d: 2 }, b: 1 }));
  });

  it("preserves array order", () => {
    expect(canonicalizeJson([1, 2])).not.toBe(canonicalizeJson([2, 1]));
  });

  it("distinguishes different values", () => {
    expect(canonicalizeJson({ a: 1 })).not.toBe(canonicalizeJson({ a: 2 }));
  });
});

describe("similarityRatio", () => {
  it("returns 1 for identical strings and 0 against empty", () => {
    expect(similarityRatio("abc", "abc")).toBe(1);
    expect(similarityRatio("", "")).toBe(1);
    expect(similarityRatio("abc", "")).toBe(0);
  });

  it("matches difflib SequenceMatcher's ratio for one differing char", () => {
    // difflib.SequenceMatcher(None, "ABC", "ABD").ratio() == 0.666...
    expect(similarityRatio("ABC", "ABD")).toBeCloseTo(2 / 3, 5);
  });

  it("returns 0 for disjoint strings", () => {
    expect(similarityRatio("abc", "xyz")).toBe(0);
  });

  it("scores a small edit as high similarity", () => {
    expect(
      similarityRatio("Best Shoes for Running", "Best Shoes for Running!"),
    ).toBeGreaterThan(0.9);
  });

  it("scores a rewording below the 0.5 threshold the diff engine uses", () => {
    expect(
      similarityRatio("Best Shoes for Running", "Wholesale Sock Inventory"),
    ).toBeLessThan(0.5);
  });
});
