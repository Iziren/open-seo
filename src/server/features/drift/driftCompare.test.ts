import { describe, expect, it } from "vitest";
import { diffSnapshots, reconcileChanges } from "./driftCompare";
import type {
  DriftAttributes,
  DriftDiff,
  DriftField,
  DriftOpenChange,
} from "./types";

const BASE: DriftAttributes = {
  url: "https://example.com/page",
  canonicalUrl: null,
  title: null,
  metaDescription: null,
  h1: null,
  schemaJsonLd: "[]",
  robotsMeta: null,
  statusCode: 200,
  indexable: true,
  wordCount: 100,
  externalLinkCount: 5,
  headersJson: "{}",
};

function attrs(overrides: Partial<DriftAttributes>): DriftAttributes {
  return { ...BASE, ...overrides };
}

function diffFor(diffs: DriftDiff[], field: DriftField): DriftDiff | undefined {
  return diffs.find((diff) => diff.field === field);
}

describe("diffSnapshots", () => {
  it("returns nothing for identical snapshots", () => {
    const a = attrs({
      title: "Acme",
      canonicalUrl: "https://example.com/page",
      schemaJsonLd: '[{"@type":"Article"}]',
    });
    expect(diffSnapshots(a, { ...a })).toEqual([]);
  });

  describe("status_code", () => {
    it("flags 200 → 404 as critical", () => {
      const diff = diffFor(
        diffSnapshots(BASE, attrs({ statusCode: 404 })),
        "status_code",
      );
      expect(diff).toMatchObject({
        changeType: "changed",
        severity: "critical",
        oldValue: "200",
        newValue: "404",
      });
    });

    it("flags non-error class changes as warning", () => {
      expect(
        diffFor(diffSnapshots(BASE, attrs({ statusCode: 301 })), "status_code"),
      ).toMatchObject({ severity: "warning" });
      expect(
        diffFor(
          diffSnapshots(attrs({ statusCode: 404 }), attrs({ statusCode: 200 })),
          "status_code",
        ),
      ).toMatchObject({ severity: "warning" });
    });

    it("ignores code changes within the same class and unknown codes", () => {
      expect(diffSnapshots(BASE, attrs({ statusCode: 204 }))).toEqual([]);
      expect(
        diffSnapshots(attrs({ statusCode: null }), attrs({ statusCode: 404 })),
      ).toEqual([]);
    });
  });

  describe("indexability", () => {
    it("flags losing indexability as critical and regaining as info", () => {
      expect(
        diffFor(diffSnapshots(BASE, attrs({ indexable: false })), "indexable"),
      ).toMatchObject({
        severity: "critical",
        oldValue: "true",
        newValue: "false",
      });
      expect(
        diffFor(
          diffSnapshots(
            attrs({ indexable: false }),
            attrs({ indexable: true }),
          ),
          "indexable",
        ),
      ).toMatchObject({ severity: "info" });
    });
  });

  describe("title", () => {
    it("flags removal as critical and addition as info", () => {
      expect(
        diffFor(
          diffSnapshots(attrs({ title: "Acme" }), attrs({ title: null })),
          "title",
        ),
      ).toMatchObject({ changeType: "removed", severity: "critical" });
      expect(
        diffFor(
          diffSnapshots(attrs({ title: null }), attrs({ title: "Acme" })),
          "title",
        ),
      ).toMatchObject({ changeType: "added", severity: "info" });
    });

    it("flags a genuine rewrite as warning", () => {
      const diff = diffFor(
        diffSnapshots(
          attrs({ title: "Acme Tools for Professionals" }),
          attrs({ title: "Budget Sock Warehouse Direct" }),
        ),
        "title",
      );
      expect(diff).toMatchObject({
        changeType: "changed",
        severity: "warning",
      });
    });

    it("ignores whitespace-only differences", () => {
      expect(
        diffSnapshots(
          attrs({ title: "Acme  Tools" }),
          attrs({ title: " Acme Tools " }),
        ),
      ).toEqual([]);
    });

    it("ignores a truncated prefix of a long baseline title", () => {
      const full =
        "The Ultimate Guide to Ranking Higher in Search Results for 2026";
      const truncated = full.slice(0, 45);
      expect(
        diffSnapshots(attrs({ title: full }), attrs({ title: truncated })),
      ).toEqual([]);
    });
  });

  describe("meta_description", () => {
    it("flags removal as warning and a rewrite as warning", () => {
      expect(
        diffFor(
          diffSnapshots(
            attrs({ metaDescription: "Old copy" }),
            attrs({ metaDescription: null }),
          ),
          "meta_description",
        ),
      ).toMatchObject({ changeType: "removed", severity: "warning" });
      expect(
        diffFor(
          diffSnapshots(
            attrs({ metaDescription: "Old copy here" }),
            attrs({ metaDescription: "Totally new marketing copy" }),
          ),
          "meta_description",
        ),
      ).toMatchObject({ changeType: "changed", severity: "warning" });
    });

    it("ignores a truncated prefix of a long description", () => {
      const full =
        "Acme sells professional-grade tools with free shipping worldwide for every order placed this season and next, plus dedicated support from real specialists for every customer, every day.";
      expect(full.length).toBeGreaterThanOrEqual(160);
      expect(
        diffSnapshots(
          attrs({ metaDescription: full }),
          attrs({ metaDescription: full.slice(0, 120) }),
        ),
      ).toEqual([]);
    });
  });

  describe("canonical_url", () => {
    it("flags removal as critical and addition as warning", () => {
      expect(
        diffFor(
          diffSnapshots(
            attrs({ canonicalUrl: "https://example.com/page" }),
            attrs({ canonicalUrl: null }),
          ),
          "canonical_url",
        ),
      ).toMatchObject({ changeType: "removed", severity: "critical" });
      expect(
        diffFor(
          diffSnapshots(
            attrs({ canonicalUrl: null }),
            attrs({ canonicalUrl: "https://example.com/page" }),
          ),
          "canonical_url",
        ),
      ).toMatchObject({ changeType: "added", severity: "warning" });
    });

    it("flags a genuinely different target as critical", () => {
      const diff = diffFor(
        diffSnapshots(
          attrs({ canonicalUrl: "https://example.com/page" }),
          attrs({ canonicalUrl: "https://other.com/elsewhere" }),
        ),
        "canonical_url",
      );
      expect(diff).toMatchObject({
        changeType: "changed",
        severity: "critical",
      });
      // Stored values stay raw so the UI shows what the tag actually said.
      expect(diff?.oldValue).toBe("https://example.com/page");
      expect(diff?.newValue).toBe("https://other.com/elsewhere");
    });

    it("ignores trailing-slash, scheme, www, and query-order variance", () => {
      expect(
        diffSnapshots(
          attrs({ canonicalUrl: "http://www.example.com/page" }),
          attrs({ canonicalUrl: "https://example.com/page/" }),
        ),
      ).toEqual([]);
      expect(
        diffSnapshots(
          attrs({ canonicalUrl: "https://example.com/page?a=1&b=2" }),
          attrs({ canonicalUrl: "https://example.com/page?b=2&a=1" }),
        ),
      ).toEqual([]);
    });
  });

  describe("h1", () => {
    it("flags removal as critical and addition as info", () => {
      expect(
        diffFor(
          diffSnapshots(attrs({ h1: "Welcome" }), attrs({ h1: null })),
          "h1",
        ),
      ).toMatchObject({ changeType: "removed", severity: "critical" });
      expect(
        diffFor(
          diffSnapshots(attrs({ h1: null }), attrs({ h1: "Welcome" })),
          "h1",
        ),
      ).toMatchObject({ changeType: "added", severity: "info" });
    });

    it("flags a near-total rewrite as critical and a small edit as warning", () => {
      expect(
        diffFor(
          diffSnapshots(
            attrs({ h1: "Best Shoes for Running" }),
            attrs({ h1: "Wholesale Sock Inventory" }),
          ),
          "h1",
        ),
      ).toMatchObject({ severity: "critical" });
      expect(
        diffFor(
          diffSnapshots(
            attrs({ h1: "Best Shoes for Running" }),
            attrs({ h1: "The Best Shoes for Running" }),
          ),
          "h1",
        ),
      ).toMatchObject({ severity: "warning" });
    });
  });

  describe("robots_meta", () => {
    it("flags directive changes as warning", () => {
      expect(
        diffFor(
          diffSnapshots(
            attrs({ robotsMeta: "index,follow" }),
            attrs({ robotsMeta: "noindex,nofollow" }),
          ),
          "robots_meta",
        ),
      ).toMatchObject({ changeType: "changed", severity: "warning" });
    });
  });
});

function openChange(
  overrides: Partial<DriftOpenChange> & Pick<DriftOpenChange, "id">,
): DriftOpenChange {
  return {
    url: "https://example.com/page",
    field: "title",
    oldValue: "Old",
    newValue: "New",
    changeType: "changed",
    ...overrides,
  };
}

describe("reconcileChanges", () => {
  const compared = new Set(["https://example.com/page"]);

  const titleDiff: DriftDiff = {
    url: "https://example.com/page",
    field: "title",
    oldValue: "Old",
    newValue: "New",
    changeType: "changed",
    severity: "warning",
  };

  it("inserts diffs with no open row", () => {
    const result = reconcileChanges({
      openChanges: [],
      diffs: [titleDiff],
      comparedUrls: compared,
    });
    expect(result.inserts).toEqual([titleDiff]);
    expect(result.resolveIds).toEqual([]);
    expect(result.keptIds).toEqual([]);
  });

  it("keeps an identical open row so detected_at survives", () => {
    const result = reconcileChanges({
      openChanges: [openChange({ id: "chg_1" })],
      diffs: [titleDiff],
      comparedUrls: compared,
    });
    expect(result.keptIds).toEqual(["chg_1"]);
    expect(result.inserts).toEqual([]);
    expect(result.resolveIds).toEqual([]);
  });

  it("retires and re-inserts when the drift changed shape", () => {
    const driftedFurther: DriftDiff = { ...titleDiff, newValue: "Newer" };
    const result = reconcileChanges({
      openChanges: [openChange({ id: "chg_1" })],
      diffs: [driftedFurther],
      comparedUrls: compared,
    });
    expect(result.resolveIds).toEqual(["chg_1"]);
    expect(result.inserts).toEqual([driftedFurther]);
  });

  it("resolves open rows whose field is back at baseline", () => {
    const result = reconcileChanges({
      openChanges: [
        openChange({ id: "chg_title" }),
        openChange({ id: "chg_h1", field: "h1" }),
      ],
      diffs: [titleDiff],
      comparedUrls: compared,
    });
    expect(result.resolveIds).toEqual(["chg_h1"]);
    expect(result.keptIds).toEqual(["chg_title"]);
  });

  it("leaves open rows for URLs that could not be fetched", () => {
    const result = reconcileChanges({
      openChanges: [
        openChange({ id: "chg_1", url: "https://example.com/down" }),
      ],
      diffs: [],
      comparedUrls: compared,
    });
    expect(result.resolveIds).toEqual([]);
    expect(result.inserts).toEqual([]);
  });
});
