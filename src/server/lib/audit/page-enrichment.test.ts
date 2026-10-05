import { describe, expect, it } from "vitest";
import { analyzeHtml } from "@/server/lib/audit/page-analyzer";
import {
  enrichPageAnalysis,
  type PageEnrichment,
} from "@/server/lib/audit/page-enrichment";

const URL = "https://example.com/product";

function analyze(html: string) {
  return analyzeHtml(html, URL, 200, 120);
}

describe("enrichPageAnalysis", () => {
  it("enriches a plain page with content, schema, and nlp signals", async () => {
    const html = `<html><head><title>Canvas Tote</title>
<meta name="description" content="A sturdy canvas tote for everyday carry."></head>
<body><h1>Canvas Tote</h1><p>${"Sturdy stitched canvas with leather handles. ".repeat(30)}</p></body></html>`;
    const enrichment: PageEnrichment = await enrichPageAnalysis(
      analyze(html),
      html,
    );

    expect(enrichment.contentScore).toBeGreaterThanOrEqual(0);
    expect(enrichment.contentScore).toBeLessThanOrEqual(100);
    expect(enrichment.schemaStatus).toBe("missing");
    expect(enrichment.schemaTypes).toEqual([]);
    expect(enrichment.schemaFindings).toEqual([]);
    expect(enrichment.nlpSummary?.tokenCount).toBeGreaterThan(0);
  });

  it("extracts schema types from JSON-LD without validating blogs as products", async () => {
    const html = `<html><head><title>Shop</title></head><body><h1>Shop</h1>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product",
"name":"Canvas Tote","image":["https://example.com/tote.jpg"],"sku":"tote-1",
"brand":{"@type":"Brand","name":"Example"},
"offers":{"@type":"Offer","price":"29.00","priceCurrency":"USD",
"availability":"https://schema.org/InStock","url":"${URL}"}}</script>
<p>${"A good tote. ".repeat(30)}</p></body></html>`;
    const enrichment: PageEnrichment = await enrichPageAnalysis(
      analyze(html),
      html,
    );

    expect(enrichment.schemaTypes).toContain("Product");
    expect(enrichment.schemaStatus).toBe("valid");
  });

  it("marks unparseable JSON-LD invalid with capped findings", async () => {
    const html = `<html><head><title>Shop</title></head><body><h1>Shop</h1>
<script type="application/ld+json">{"@type": broken</script>
<p>${"A good tote. ".repeat(30)}</p></body></html>`;
    const enrichment: PageEnrichment = await enrichPageAnalysis(
      analyze(html),
      html,
    );

    expect(enrichment.schemaStatus).toBe("invalid");
    expect(enrichment.schemaFindings[0]?.code).toBe("jsonld-parse-error");
  });
});
