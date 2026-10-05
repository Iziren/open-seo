import { describe, expect, it } from "vitest";
import {
  buildGraphDocument,
  generateBreadcrumbList,
  generateDiscussionForumPosting,
  generateFaqPage,
  generateOrganization,
  generateOrderAction,
  generateProduct,
  generateProfilePage,
  generateReservation,
  generateWebsite,
  serializeJsonLdForScript,
  type DiscussionPostingInput,
  type FaqPageInput,
  type JsonLdNode,
  type OfferInput,
  type OrderActionInput,
  type OrganizationInput,
  type ProductInput,
  type ProfilePageInput,
  type ReservationInput,
  type WebsiteInput,
} from "@/server/lib/audit/schema-generate";

const FULL_PRODUCT: ProductInput = {
  name: "Aurora Desk Lamp",
  description: "Warm-dimming desk lamp with a walnut base.",
  image: ["https://cdn.example.com/lamp-1.jpg"],
  sku: "AUR-100",
  brand: { name: "Aurora", url: "https://example.com/brands/aurora" },
  url: "https://shop.example.com/lamp",
  offers: {
    price: "49.99",
    priceCurrency: "USD",
    availability: "InStock",
    url: "https://shop.example.com/lamp#offer",
  },
  aggregateRating: { ratingValue: 4.7, reviewCount: 128 },
};

describe("generateProduct", () => {
  it("emits every supplied merchant-listing field", () => {
    const node = generateProduct(FULL_PRODUCT);
    expect(node).toMatchObject({
      "@type": "Product",
      name: "Aurora Desk Lamp",
      description: "Warm-dimming desk lamp with a walnut base.",
      image: ["https://cdn.example.com/lamp-1.jpg"],
      sku: "AUR-100",
      brand: {
        "@type": "Brand",
        name: "Aurora",
        url: "https://example.com/brands/aurora",
      },
      url: "https://shop.example.com/lamp",
      aggregateRating: {
        "@type": "AggregateRating",
        ratingValue: 4.7,
        reviewCount: 128,
      },
    });
    expect(node["offers"]).toEqual({
      "@type": "Offer",
      price: "49.99",
      priceCurrency: "USD",
      availability: "https://schema.org/InStock",
      url: "https://shop.example.com/lamp#offer",
    });
  });

  it("never fabricates ratings, images, or offers that were not supplied", () => {
    const node = generateProduct({ name: "Bare Widget" });
    expect(node).toEqual({ "@type": "Product", name: "Bare Widget" });
    expect(node).not.toHaveProperty("aggregateRating");
    expect(node).not.toHaveProperty("offers");
    expect(node).not.toHaveProperty("image");
    // An empty image array would trip the non-empty-image validator rule.
    expect(generateProduct({ name: "X", image: [] })).not.toHaveProperty(
      "image",
    );
  });

  it("keeps availability as an absolute schema.org URL when already absolute", () => {
    const offers: OfferInput[] = [
      { price: 10, priceCurrency: "EUR", availability: "OutOfStock" },
      {
        price: 12,
        priceCurrency: "EUR",
        availability: "https://schema.org/PreOrder",
      },
    ];
    const node = generateProduct({ name: "Multi", offers });
    expect(node["offers"]).toEqual([
      {
        "@type": "Offer",
        price: 10,
        priceCurrency: "EUR",
        availability: "https://schema.org/OutOfStock",
      },
      {
        "@type": "Offer",
        price: 12,
        priceCurrency: "EUR",
        availability: "https://schema.org/PreOrder",
      },
    ]);
  });

  it("accepts a bare string brand", () => {
    expect(generateProduct({ name: "X", brand: "Acme" })["brand"]).toEqual({
      "@type": "Brand",
      name: "Acme",
    });
  });
});

describe("generateOrganization / generateWebsite", () => {
  it("builds an organization from supplied fields only", () => {
    const input: OrganizationInput = {
      name: "Acme Inc",
      url: "https://example.com",
      sameAs: ["https://github.com/acme"],
    };
    expect(generateOrganization(input)).toEqual({
      "@type": "Organization",
      name: "Acme Inc",
      url: "https://example.com",
      sameAs: ["https://github.com/acme"],
    });
  });

  it("emits a SearchAction only when a search URL pattern is known", () => {
    const plain: WebsiteInput = { name: "Ex", url: "https://example.com" };
    expect(generateWebsite(plain)).toEqual({
      "@type": "WebSite",
      name: "Ex",
      url: "https://example.com",
    });

    const searchable: WebsiteInput = {
      ...plain,
      searchUrlTemplate: "https://example.com/search?q={search_term_string}",
    };
    expect(generateWebsite(searchable)).toMatchObject({
      potentialAction: {
        "@type": "SearchAction",
        target: {
          "@type": "EntryPoint",
          urlTemplate: "https://example.com/search?q={search_term_string}",
        },
        "query-input": "required name=search_term_string",
      },
    });
  });
});

describe("generateBreadcrumbList", () => {
  it("builds one list item per path segment with absolute URLs", () => {
    const node = generateBreadcrumbList(
      "https://example.com/catalog/red-shoes?utm=1",
      "Example",
    );
    expect(node["@type"]).toBe("BreadcrumbList");
    expect(node["itemListElement"]).toEqual([
      {
        "@type": "ListItem",
        position: 1,
        name: "Example",
        item: "https://example.com/",
      },
      {
        "@type": "ListItem",
        position: 2,
        name: "Catalog",
        item: "https://example.com/catalog",
      },
      {
        "@type": "ListItem",
        position: 3,
        name: "Red Shoes",
        item: "https://example.com/catalog/red-shoes",
      },
    ]);
  });

  it("falls back to a single item for an unparseable URL", () => {
    expect(generateBreadcrumbList("not a url")).toEqual({
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "not a url" },
      ],
    });
  });
});

describe("generateFaqPage", () => {
  it("maps explicit Q&A pairs onto Question/Answer nodes", () => {
    const input: FaqPageInput = {
      mainEntity: [
        {
          question: "Do you ship worldwide?",
          answer: "Yes, to 40+ countries.",
        },
      ],
      url: "https://example.com/faq",
    };
    expect(generateFaqPage(input)).toEqual({
      "@type": "FAQPage",
      mainEntity: [
        {
          "@type": "Question",
          name: "Do you ship worldwide?",
          acceptedAnswer: {
            "@type": "Answer",
            text: "Yes, to 40+ countries.",
          },
        },
      ],
      url: "https://example.com/faq",
    });
  });
});

describe("buildGraphDocument and serializeJsonLdForScript", () => {
  it("wraps nodes in a single document context", () => {
    const doc = buildGraphDocument([generateProduct({ name: "X" })]);
    expect(doc).toEqual({
      "@context": "https://schema.org",
      "@graph": [{ "@type": "Product", name: "X" }],
    });
  });

  it("escapes < so a </script> payload cannot break out of the element", () => {
    const hostile: JsonLdNode = {
      "@type": "Product",
      name: "X",
      description: "</script><script>alert(1)</script>",
    };
    const serialized = serializeJsonLdForScript(hostile);
    expect(serialized).not.toContain("<");
    expect(serialized.toLowerCase()).not.toContain("</script");
    expect(JSON.parse(serialized)).toEqual(hostile);
  });
});

describe("ports of schema_generate.py", () => {
  it("builds a reservation with defaults and optional fields", () => {
    const input: ReservationInput = {
      provider: "Marea NYC",
      startTime: "2026-06-04T19:30:00-04:00",
      partySize: 4,
      reservationId: "RX-12345",
      customerName: "Sara Park",
    };
    expect(generateReservation(input)).toEqual({
      "@type": "FoodEstablishmentReservation",
      reservationStatus: "https://schema.org/ReservationConfirmed",
      provider: { "@type": "Organization", name: "Marea NYC" },
      reservationFor: { "@type": "FoodEstablishment", name: "Marea NYC" },
      startTime: "2026-06-04T19:30:00-04:00",
      partySize: 4,
      reservationId: "RX-12345",
      underName: { "@type": "Person", name: "Sara Park" },
    });
    expect(
      generateReservation({
        provider: "Cars",
        startTime: "t",
        kind: "RentalCarReservation",
      }),
    ).toMatchObject({
      "@type": "RentalCarReservation",
      reservationFor: { "@type": "Place" },
    });
  });

  it("builds an OrderAction with platforms, merchant, and payment methods", () => {
    const input: OrderActionInput = {
      merchant: "Acme Pizza",
      orderUrl: "https://acme.example/order",
      acceptedPaymentMethods: ["PaymentCard"],
    };
    expect(generateOrderAction(input)).toMatchObject({
      "@type": "OrderAction",
      name: "Order online",
      target: {
        "@type": "EntryPoint",
        urlTemplate: "https://acme.example/order",
        actionPlatform: [
          "https://schema.org/DesktopWebPlatform",
          "https://schema.org/MobileWebPlatform",
        ],
      },
      merchant: { "@type": "Organization", name: "Acme Pizza" },
      acceptedPaymentMethod: [
        { "@type": "PaymentMethod", name: "PaymentCard" },
      ],
    });
  });

  it("builds a DiscussionForumPosting with interaction statistics", () => {
    const input: DiscussionPostingInput = {
      headline: "How do you score INP correctly?",
      author: "Sara Park",
      url: "https://forum.example.com/t/123",
      datePublished: "2026-05-12T14:00:00Z",
      commentCount: 3,
      interactionCounts: { LikeAction: 17 },
    };
    expect(generateDiscussionForumPosting(input)).toMatchObject({
      "@type": "DiscussionForumPosting",
      author: { "@type": "Person", name: "Sara Park" },
      mainEntityOfPage: { "@type": "WebPage", "@id": input.url },
      commentCount: 3,
      interactionStatistic: [
        {
          "@type": "InteractionCounter",
          interactionType: "https://schema.org/LikeAction",
          userInteractionCount: 17,
        },
      ],
    });
  });

  it("builds a ProfilePage with entity-graph fields", () => {
    const input: ProfilePageInput = {
      name: "Daniel Agrici",
      url: "https://agricidaniel.com/about",
      sameAs: ["https://github.com/AgriciDaniel"],
      knowsAbout: ["SEO", "Schema markup"],
      worksFor: "OpenSEO",
      jobTitle: "Founder",
    };
    expect(generateProfilePage(input)).toEqual({
      "@type": "ProfilePage",
      url: "https://agricidaniel.com/about",
      mainEntity: {
        "@type": "Person",
        name: "Daniel Agrici",
        url: "https://agricidaniel.com/about",
        sameAs: ["https://github.com/AgriciDaniel"],
        knowsAbout: ["SEO", "Schema markup"],
        worksFor: { "@type": "Organization", name: "OpenSEO" },
        jobTitle: "Founder",
      },
    });
  });
});
