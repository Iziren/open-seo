import { describe, expect, it } from "vitest";
import { diffSnapshots } from "./driftCompare";
import type { DriftAttributes, DriftDiff, DriftField } from "./types";

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

function attrs(overrides: Partial<DriftAttributes> = {}): DriftAttributes {
  return { ...BASE, ...overrides };
}

function diffFor(diffs: DriftDiff[], field: DriftField): DriftDiff | undefined {
  return diffs.find((diff) => diff.field === field);
}

describe("diffSnapshots: schema, counts, and headers", () => {
  describe("schema_json_ld", () => {
    const article = '[{"@type":"Article","headline":"Hi"}]';

    it("flags total removal as critical", () => {
      const diff = diffFor(
        diffSnapshots(attrs({ schemaJsonLd: article }), attrs()),
        "schema_json_ld",
      );
      expect(diff).toMatchObject({
        changeType: "removed",
        severity: "critical",
        newValue: null,
      });
      expect(diff?.oldValue).toContain("Article");
    });

    it("downgrades removal to warning when only retired types remain", () => {
      for (const type of ["FAQPage", "HowTo", "Dataset"]) {
        expect(
          diffFor(
            diffSnapshots(
              attrs({ schemaJsonLd: JSON.stringify([{ "@type": type }]) }),
              attrs(),
            ),
            "schema_json_ld",
          ),
        ).toMatchObject({ severity: "warning" });
      }
    });

    it("flags addition as info", () => {
      expect(
        diffFor(
          diffSnapshots(attrs(), attrs({ schemaJsonLd: article })),
          "schema_json_ld",
        ),
      ).toMatchObject({ changeType: "added", severity: "info" });
    });

    it("ignores key-order-only differences", () => {
      const a = '[{"@type":"Article","headline":"Hi","author":"Ada"}]';
      const b = '[{"author":"Ada","headline":"Hi","@type":"Article"}]';
      expect(
        diffSnapshots(attrs({ schemaJsonLd: a }), attrs({ schemaJsonLd: b })),
      ).toEqual([]);
    });

    it("flags content changes as warning", () => {
      expect(
        diffFor(
          diffSnapshots(
            attrs({ schemaJsonLd: article }),
            attrs({ schemaJsonLd: '[{"@type":"Article","headline":"Bye"}]' }),
          ),
          "schema_json_ld",
        ),
      ).toMatchObject({ changeType: "changed", severity: "warning" });
    });

    it("treats unparsable stored JSON as absent", () => {
      expect(
        diffSnapshots(attrs({ schemaJsonLd: "{not json" }), attrs()),
      ).toEqual([]);
    });
  });

  describe("counts and headers", () => {
    it("flags word-count and link-count changes as info", () => {
      const diffs = diffSnapshots(
        attrs({ wordCount: 100, externalLinkCount: 5 }),
        attrs({ wordCount: 10, externalLinkCount: 7 }),
      );
      expect(diffFor(diffs, "word_count")).toMatchObject({
        changeType: "changed",
        severity: "info",
        newValue: "10",
      });
      expect(diffFor(diffs, "external_link_count")).toMatchObject({
        severity: "info",
        newValue: "7",
      });
    });

    it("flags header changes as info and ignores key-order-only changes", () => {
      expect(
        diffFor(
          diffSnapshots(
            attrs({ headersJson: "{}" }),
            attrs({ headersJson: '{"x-robots-tag":"noindex"}' }),
          ),
          "headers",
        ),
      ).toMatchObject({ severity: "info" });
      expect(
        diffSnapshots(
          attrs({ headersJson: '{"etag":"abc","content-type":"text/html"}' }),
          attrs({ headersJson: '{"content-type":"text/html","etag":"abc"}' }),
        ),
      ).toEqual([]);
    });
  });
});
