import { describe, expect, it } from "vitest";
import {
  buildGraphDocument,
  generateBreadcrumbList,
  generateFaqPage,
  generateOrganization,
  generateProduct,
  generateWebsite,
} from "@/server/lib/audit/schema-generate";
import {
  type SchemaFinding,
  type SchemaValidationResult,
  type SchemaValidateOptions,
  validateSchema,
} from "@/server/lib/audit/schema-validate";

const VALID_PRODUCT: Record<string, unknown> = {
  "@context": "https://schema.org",
  "@type": "Product",
  name: "Aurora Desk Lamp",
  description: "A warm desk lamp.",
  image: ["https://cdn.example.com/lamp.jpg"],
  sku: "LAMP-1",
  brand: { "@type": "Brand", name: "Aurora" },
  url: "https://shop.example.com/lamp",
  offers: {
    "@type": "Offer",
    price: 49.99,
    priceCurrency: "USD",
    availability: "https://schema.org/InStock",
  },
};

function check(
  payload: unknown,
  options?: SchemaValidateOptions,
): SchemaValidationResult {
  return validateSchema(payload, options);
}

function codes(list: SchemaFinding[]): string[] {
  return list.map((finding) => finding.code);
}

describe("validateSchema", () => {
  it("accepts a complete Product document", () => {
    const result = check(VALID_PRODUCT);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("accepts a full generated graph (product through FAQ)", () => {
    const graph = buildGraphDocument([
      generateProduct({
        name: "Aurora Desk Lamp",
        description: "A warm desk lamp.",
        image: ["https://cdn.example.com/lamp.jpg"],
        sku: "LAMP-1",
        brand: "Aurora",
        url: "https://shop.example.com/lamp",
        offers: {
          price: "49.99",
          priceCurrency: "USD",
          availability: "InStock",
          url: "https://shop.example.com/lamp",
        },
        aggregateRating: { ratingValue: 4.6, reviewCount: 12 },
      }),
      generateOrganization({
        name: "Aurora",
        url: "https://shop.example.com",
        logo: "https://cdn.example.com/logo.png",
        sameAs: ["https://github.com/aurora"],
      }),
      generateWebsite({
        name: "Aurora Shop",
        url: "https://shop.example.com",
        searchUrlTemplate: "https://shop.example.com/search?q={search_term}",
      }),
      generateBreadcrumbList(
        "https://shop.example.com/products/lamp",
        "Aurora",
      ),
      generateFaqPage({
        mainEntity: [{ question: "Is it warm?", answer: "Yes." }],
        url: "https://shop.example.com/faq",
      }),
    ]);
    const result = check(graph);
    expect(codes(result.errors)).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("rejects non-document payloads", () => {
    for (const payload of ["nope", 42, null, undefined]) {
      expect(codes(check(payload).errors)).toEqual(["not-jsonld-document"]);
    }
  });

  it("flags a missing @context on object and array roots", () => {
    const withoutContext = { ...VALID_PRODUCT };
    delete withoutContext["@context"];
    expect(codes(check(withoutContext).errors)).toContain("missing-context");
    const entries = [VALID_PRODUCT, { "@type": "Product", name: "B" }];
    expect(codes(check(entries).errors)).toContain("missing-context");
    expect(check([VALID_PRODUCT]).ok).toBe(true);
  });

  it("flags wrong-shaped values through structural schemas", () => {
    const result = check({
      "@context": "https://schema.org",
      "@type": "Product",
      name: 42,
      offers: "not-an-offer",
    });
    expect(codes(result.errors)).toContain("structural-product");
    expect(result.ok).toBe(false);
  });

  it("flags missing required Product fields", () => {
    const result = check({
      "@context": "https://schema.org",
      "@type": "Product",
      description: "no name here",
    });
    expect(codes(result.errors)).toEqual(
      expect.arrayContaining([
        "missing-product-name",
        "missing-product-image",
        "missing-product-offers",
      ]),
    );
  });

  it("flags non-Offer offers as merchant-listing errors", () => {
    const aggregate = check({
      "@context": "https://schema.org",
      "@type": "Product",
      name: "Lamp",
      image: "https://cdn.example.com/lamp.jpg",
      offers: { "@type": "AggregateOffer", lowPrice: 10, highPrice: 50 },
    });
    expect(codes(aggregate.errors)).toContain("merchant-listing-offer-type");
    const untyped = check({
      "@context": "https://schema.org",
      "@type": "Product",
      name: "Lamp",
      image: "https://cdn.example.com/lamp.jpg",
      offers: { price: 10, priceCurrency: "USD" },
    });
    expect(codes(untyped.errors)).toContain("merchant-listing-offer-type");
  });

  it("flags unparsable prices and invalid availability", () => {
    const result = check({
      "@context": "https://schema.org",
      "@type": "Product",
      name: "Lamp",
      image: "https://cdn.example.com/lamp.jpg",
      offers: {
        "@type": "Offer",
        price: "ask us",
        priceCurrency: "USD",
        availability: "InStockish",
      },
    });
    expect(codes(result.errors)).toEqual(
      expect.arrayContaining(["price-not-parsable", "invalid-availability"]),
    );
  });

  it("flags relative URLs on URL-bearing fields", () => {
    const result = check({ ...VALID_PRODUCT, url: "/lamp" });
    expect(codes(result.errors)).toContain("relative-url");
  });

  it("flags orphan offers and missing products", () => {
    const orphan = check({
      "@context": "https://schema.org",
      "@type": "Offer",
      price: 10,
      priceCurrency: "USD",
    });
    expect(codes(orphan.errors)).toEqual(
      expect.arrayContaining(["missing-product", "orphan-offer"]),
    );
  });

  it("flags duplicate Product blocks", () => {
    const result = check({
      "@context": "https://schema.org",
      "@graph": [VALID_PRODUCT, { ...VALID_PRODUCT, "@context": undefined }],
    });
    expect(codes(result.errors)).toContain("duplicate-product");
  });

  it("flags incomplete aggregate ratings", () => {
    const missingCount = check({
      ...VALID_PRODUCT,
      aggregateRating: { "@type": "AggregateRating", ratingValue: 4.5 },
    });
    expect(codes(missingCount.errors)).toContain(
      "aggregate-rating-missing-review-count",
    );
    const missingValue = check({
      ...VALID_PRODUCT,
      aggregateRating: { "@type": "AggregateRating", reviewCount: 3 },
    });
    expect(codes(missingValue.errors)).toContain(
      "aggregate-rating-missing-rating-value",
    );
  });

  it("flags deprecated rich-result types", () => {
    const result = check({
      "@context": "https://schema.org",
      "@graph": [
        VALID_PRODUCT,
        { "@type": "ClaimReview", claimReviewed: "x", reviewRating: {} },
      ],
    });
    expect(codes(result.errors)).toContain("deprecated-type");
  });

  it("requires EU energy only when asked", () => {
    const off = check(VALID_PRODUCT);
    expect(codes(off.errors)).not.toContain("missing-eu-energy-class");
    const on = check(VALID_PRODUCT, { requireEuEnergy: true });
    expect(codes(on.errors)).toContain("missing-eu-energy-class");
  });

  it("collects warnings and recommendations without failing the page", () => {
    const result = check(VALID_PRODUCT);
    expect(result.ok).toBe(true);
    expect(codes(result.warnings)).toEqual(
      expect.arrayContaining([
        "missing-return-policy",
        "missing-shipping-details",
        "missing-member-program",
      ]),
    );
    expect(codes(result.recommendations)).toContain("no-product-group");
    expect(codes(result.recommendations)).not.toContain(
      "missing-product-identifier",
    );
  });

  it("emits identifier, brand, and url recommendations when absent", () => {
    const result = check({
      "@context": "https://schema.org",
      "@type": "Product",
      name: "Lamp",
      description: "A lamp.",
      image: "https://cdn.example.com/lamp.jpg",
      offers: {
        "@type": "Offer",
        price: 1,
        priceCurrency: "EUR",
        availability: "InStock",
      },
    });
    expect(codes(result.recommendations)).toEqual(
      expect.arrayContaining([
        "missing-product-identifier",
        "missing-product-brand",
        "missing-product-url",
      ]),
    );
    expect(result.ok).toBe(true);
  });
});
