import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  env: {},
  DurableObject: class {
    kind = "mock";
  },
}));

import { SchemaService } from "./SchemaService";
import {
  schemaTypeSchema,
  type GeneratedSchema,
  type SchemaType,
} from "./SchemaService";

const PRODUCT = {
  name: "Canvas Tote",
  description: "A sturdy tote.",
  image: ["https://example.com/tote.jpg"],
  sku: "tote-1",
  brand: "Example",
  url: "https://example.com/products/tote",
  offers: {
    price: "29.00",
    priceCurrency: "USD",
    availability: "InStock",
    url: "https://example.com/products/tote",
  },
};

describe("SchemaService.generate", () => {
  it("accepts the five documented schema types", () => {
    const types: SchemaType[] = [
      "Product",
      "Organization",
      "Website",
      "BreadcrumbList",
      "FAQPage",
    ];
    for (const type of types) {
      expect(schemaTypeSchema.parse(type)).toBe(type);
    }
    expect(() => schemaTypeSchema.parse("Article")).toThrow();
  });

  it("generates a self-validating Product document", async () => {
    const result: GeneratedSchema = await SchemaService.generate({
      projectId: "project-1",
      type: "Product",
      data: PRODUCT,
    });

    expect(result.type).toBe("Product");
    expect(JSON.stringify(result.document)).toContain("Canvas Tote");
    expect(result.script).toContain("Canvas Tote");
    expect(result.script.includes("</script")).toBe(false);
    expect(result.validation.ok).toBe(true);
  });

  it("generates BreadcrumbList from a URL path", async () => {
    const result = await SchemaService.generate({
      projectId: "project-1",
      type: "BreadcrumbList",
      data: {
        pageUrl: "https://example.com/collections/bags/tote",
        siteName: "Example",
      },
    });

    expect(JSON.stringify(result.document)).toContain("BreadcrumbList");
    expect(result.validation.ok).toBe(true);
  });

  it("rejects invalid product data at the boundary", async () => {
    await expect(
      SchemaService.generate({
        projectId: "project-1",
        type: "Product",
        data: { description: "no name" },
      }),
    ).rejects.toThrow();
  });
});

describe("SchemaService.validate", () => {
  it("flags documents with errors", () => {
    const result = SchemaService.validate({
      projectId: "project-1",
      document: { "@type": "Product" },
    });

    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

describe("SchemaService.extractFromUrl", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes("cloudflare-dns.com")) {
          return new Response(JSON.stringify({ Status: 0, Answer: [] }), {
            status: 200,
            headers: { "content-type": "application/dns-json" },
          });
        }
        return new Response(
          `<html><head><title>T</title></head><body><h1>T</h1>` +
            `<script type="application/ld+json">{"@context":"https://schema.org",` +
            `"@type":"Product","name":"Tote","image":["https://example.com/t.jpg"]}</script>` +
            `<p>${"Words. ".repeat(30)}</p></body></html>`,
          { status: 200, headers: { "content-type": "text/html" } },
        );
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("extracts and validates page markup", async () => {
    const result = await SchemaService.extractFromUrl({
      projectId: "project-1",
      url: "https://example.com/products/tote",
    });

    expect(result.types).toContain("Product");
    expect(result.scriptCount).toBe(1);
    expect(typeof result.validation.ok).toBe("boolean");
  });
});
