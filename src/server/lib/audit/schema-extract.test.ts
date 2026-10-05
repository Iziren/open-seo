import { describe, expect, it } from "vitest";
import {
  INDEXED_SCHEMA_TYPES,
  buildSchemaIndex,
  extractSchemaFromHtml,
  parseJsonLdScript,
  type IndexedSchemaType,
  type JsonLdEntity,
  type SchemaExtraction,
  type SchemaScriptResult,
} from "@/server/lib/audit/schema-extract";

const PRODUCT_SCRIPT = `<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "Product",
  "name": "Aurora Desk Lamp",
  "image": ["https://cdn.example.com/lamp-1.jpg"],
  "offers": {
    "@type": "Offer",
    "price": "49.99",
    "priceCurrency": "USD",
    "availability": "https://schema.org/InStock",
    "url": "https://shop.example.com/lamp"
  }
}
</script>`;

function extract(html: string): SchemaExtraction {
  return extractSchemaFromHtml(html);
}

function entity(types: string[], value: Record<string, unknown> = {}) {
  const result: JsonLdEntity = { types, value };
  return result;
}

function asOk(
  script: SchemaScriptResult,
): Extract<SchemaScriptResult, { ok: true }> {
  if (!script.ok) throw new Error(`expected ok script, got: ${script.error}`);
  return script;
}

describe("parseJsonLdScript", () => {
  it("parses a single object with its document context", () => {
    const script = parseJsonLdScript(
      '{"@context":"https://schema.org","@type":"WebSite","name":"Ex"}',
      2,
    );
    const ok = asOk(script);
    expect(ok.scriptIndex).toBe(2);
    expect(ok.context).toBe("https://schema.org");
    expect(ok.entities).toHaveLength(1);
    expect(ok.entities[0].types).toEqual(["WebSite"]);
    expect(ok.entities[0].value["name"]).toBe("Ex");
  });

  it("flattens @graph members into entities", () => {
    const ok = asOk(
      parseJsonLdScript(
        JSON.stringify({
          "@context": "https://schema.org",
          "@graph": [
            { "@type": "Organization", name: "Ex" },
            { "@type": "BreadcrumbList", itemListElement: [] },
          ],
        }),
        0,
      ),
    );
    expect(ok.entities.map((e) => e.types[0])).toEqual([
      "Organization",
      "BreadcrumbList",
    ]);
  });

  it("accepts a single-object @graph and an array root", () => {
    const graphObject = asOk(
      parseJsonLdScript('{"@graph":{"@type":"Article","headline":"Hi"}}', 0),
    );
    expect(graphObject.entities[0].types).toEqual(["Article"]);

    const arrayRoot = asOk(
      parseJsonLdScript('[{"@type":"Product"},{"@type":"Offer"}]', 1),
    );
    // Array roots carry no document-level @context of their own.
    expect(arrayRoot.context).toBeNull();
    expect(arrayRoot.entities).toHaveLength(2);
  });

  it("normalizes @type arrays and drops non-string entries", () => {
    const ok = asOk(
      parseJsonLdScript(
        '{"@type":["Product", 42, "SchemaOrgProduct"],"name":"X"}',
        0,
      ),
    );
    expect(ok.entities[0].types).toEqual(["Product", "SchemaOrgProduct"]);
  });

  it("reports malformed JSON instead of throwing", () => {
    const script = parseJsonLdScript('{"name": "broken"', 7);
    expect(script.ok).toBe(false);
    if (script.ok) throw new Error("expected failure");
    expect(script.scriptIndex).toBe(7);
    expect(script.error).toContain("invalid JSON");
  });

  it("rejects scalar roots and non-object array entries", () => {
    const scalar = parseJsonLdScript('"just a string"', 0);
    expect(scalar.ok).toBe(false);
    if (scalar.ok) throw new Error("expected failure");
    expect(scalar.error).toContain("object or an array");

    const nested = parseJsonLdScript('{"@graph":[42]}', 0);
    expect(nested.ok).toBe(false);
    if (nested.ok) throw new Error("expected failure");
    expect(nested.error).toContain("@graph[0]");
  });
});

describe("extractSchemaFromHtml", () => {
  it("extracts the product script and indexes it", () => {
    const extraction = extract(`<html><head>${PRODUCT_SCRIPT}</head></html>`);
    expect(extraction.scripts).toHaveLength(1);
    expect(extraction.scripts[0].ok).toBe(true);
    expect(extraction.index.Product).toHaveLength(1);
    expect(extraction.index.Organization).toHaveLength(0);
    expect(extraction.entities).toHaveLength(1);
    expect(extraction.index.Product[0].types).toEqual(["Product"]);
  });

  it("handles multiple scripts and keeps going after a broken one", () => {
    const html = `
      <script type="application/ld+json">{"@type":"Organization","name":"Ex"}</script>
      <script type="application/ld+json">{ not json </script>
      <script type="application/ld+json">{"@type":"WebSite","name":"Ex"}</script>`;
    const extraction = extract(html);
    expect(extraction.scripts).toHaveLength(3);
    expect(extraction.scripts.filter((s) => s.ok)).toHaveLength(2);
    const failed = extraction.scripts[1];
    if (!failed || failed.ok) throw new Error("expected the middle to fail");
    expect(failed.scriptIndex).toBe(1);
    expect(extraction.index.Organization).toHaveLength(1);
    expect(extraction.index.WebSite).toHaveLength(1);
  });

  it("matches the JSON-LD type prefix but skips external scripts", () => {
    const html = `
      <script type="application/ld+json; charset=utf-8">{"@type":"FAQPage"}</script>
      <script type="application/ld+json" src="https://cdn.example.com/schema.json"></script>
      <script type="text/javascript">{"@type":"Product"}</script>
      <script>{"@type":"Product"}</script>`;
    const extraction = extract(html);
    expect(extraction.scripts).toHaveLength(1);
    expect(extraction.index.FAQPage).toHaveLength(1);
    expect(extraction.index.Product).toHaveLength(0);
  });

  it("never throws on hostile or truncated markup", () => {
    // A literal </script> inside a JSON string terminates the element in
    // HTML, leaving a truncated body — parseable as a failure, not a throw.
    expect(() =>
      extract('<script type="application/ld+json">{"a":"</script>"}</script>'),
    ).not.toThrow();
    const truncated = extract(
      '<html><script type="application/ld+json">{"@type":"Product"',
    );
    expect(truncated.scripts[0].ok).toBe(false);
    expect(extract("")).toEqual({
      scripts: [],
      entities: [],
      index: {
        Product: [],
        Organization: [],
        BreadcrumbList: [],
        FAQPage: [],
        Article: [],
        WebSite: [],
      },
    });
  });

  it("indexes every configured type from one graph document", () => {
    const nodes = INDEXED_SCHEMA_TYPES.map((type) => ({
      "@type": type,
      name: type,
    }));
    const html = `<script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org",
      "@graph": nodes,
    })}</script>`;
    const extraction = extract(html);
    for (const type of INDEXED_SCHEMA_TYPES) {
      const bucket: IndexedSchemaType = type;
      expect(extraction.index[bucket]).toHaveLength(1);
    }
  });
});

describe("buildSchemaIndex", () => {
  it("groups entities by every indexed type", () => {
    const entities = [
      entity(["Product", "Thing"]),
      entity(["Product"]),
      entity(["Organization"]),
      entity(["WebPage"]),
    ];
    const index = buildSchemaIndex(entities);
    expect(index.Product).toHaveLength(2);
    expect(index.Organization).toHaveLength(1);
    expect(index.Article).toHaveLength(0);
    expect(index.BreadcrumbList).toHaveLength(0);
  });
});
