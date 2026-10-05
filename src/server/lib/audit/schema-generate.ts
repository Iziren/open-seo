/**
 * JSON-LD generators: page/seed data in, one `@graph` document out.
 *
 * Every builder is honest by construction — ratings, search actions, offer
 * fields, and Q&A are emitted only when the caller supplies real data, never
 * defaulted, because fabricated structured data risks manual actions.
 *
 * Node builders return bare nodes; `buildGraphDocument` adds the document
 * `@context` once for the whole graph (the convention Google's Rich Results
 * Test accepts for multi-entity pages).
 */
export type JsonLdNode = Record<string, unknown>;

function assignDefined(
  target: JsonLdNode,
  entries: Record<string, unknown>,
): JsonLdNode {
  for (const [key, value] of Object.entries(entries)) {
    if (value !== undefined) target[key] = value;
  }
  return target;
}

/** Accept "InStock" or a full URL; emit the canonical schema.org URL. */
function schemaUrl(value: string): string {
  return value.startsWith("http://") || value.startsWith("https://")
    ? value
    : `https://schema.org/${value}`;
}

// ---- Product ---------------------------------------------------------------

export interface OfferInput {
  price: number | string;
  priceCurrency: string;
  /** "InStock" etc. or a full ItemAvailability URL. Omitted, not defaulted. */
  availability?: string;
  url?: string;
  name?: string;
  priceValidUntil?: string;
}

interface AggregateRatingInput {
  // Required real values: there is no path that invents a rating.
  ratingValue: number;
  reviewCount: number;
  bestRating?: number;
  worstRating?: number;
}

export interface ProductInput {
  name: string;
  description?: string;
  image?: string[];
  sku?: string;
  gtin?: string;
  mpn?: string;
  brand?: string | { name: string; url?: string };
  url?: string;
  offers?: OfferInput | OfferInput[];
  aggregateRating?: AggregateRatingInput;
}

function normalizeBrand(brand: ProductInput["brand"]): JsonLdNode | undefined {
  if (brand === undefined) return undefined;
  if (typeof brand === "string") return { "@type": "Brand", name: brand };
  return assignDefined(
    { "@type": "Brand", name: brand.name },
    { url: brand.url },
  );
}

function normalizeOffer(offer: OfferInput): JsonLdNode {
  return assignDefined(
    {
      "@type": "Offer",
      price: offer.price,
      priceCurrency: offer.priceCurrency,
    },
    {
      availability: offer.availability
        ? schemaUrl(offer.availability)
        : undefined,
      url: offer.url,
      name: offer.name,
      priceValidUntil: offer.priceValidUntil,
    },
  );
}

function normalizeOffers(
  offers: ProductInput["offers"],
): JsonLdNode | JsonLdNode[] | undefined {
  if (offers === undefined) return undefined;
  const normalized = (Array.isArray(offers) ? offers : [offers]).map(
    normalizeOffer,
  );
  if (normalized.length === 0) return undefined;
  return normalized.length === 1 ? normalized[0] : normalized;
}

function normalizeRating(
  rating: AggregateRatingInput | undefined,
): JsonLdNode | undefined {
  if (rating === undefined) return undefined;
  return assignDefined(
    {
      "@type": "AggregateRating",
      ratingValue: rating.ratingValue,
      reviewCount: rating.reviewCount,
    },
    { bestRating: rating.bestRating, worstRating: rating.worstRating },
  );
}

export function generateProduct(input: ProductInput): JsonLdNode {
  return assignDefined(
    { "@type": "Product", name: input.name },
    {
      description: input.description,
      image:
        input.image && input.image.length > 0 ? [...input.image] : undefined,
      sku: input.sku,
      gtin: input.gtin,
      mpn: input.mpn,
      brand: normalizeBrand(input.brand),
      url: input.url,
      offers: normalizeOffers(input.offers),
      aggregateRating: normalizeRating(input.aggregateRating),
    },
  );
}

// ---- Organization / WebSite ------------------------------------------------

export interface OrganizationInput {
  name: string;
  url?: string;
  logo?: string;
  sameAs?: string[];
  description?: string;
}

export function generateOrganization(input: OrganizationInput): JsonLdNode {
  return assignDefined(
    { "@type": "Organization", name: input.name },
    {
      url: input.url,
      logo: input.logo,
      sameAs: input.sameAs ? [...input.sameAs] : undefined,
      description: input.description,
    },
  );
}

export interface WebsiteInput {
  name: string;
  url: string;
  /** Search URL pattern; the SearchAction is emitted only when supplied. */
  searchUrlTemplate?: string;
}

export function generateWebsite(input: WebsiteInput): JsonLdNode {
  const node: JsonLdNode = {
    "@type": "WebSite",
    name: input.name,
    url: input.url,
  };
  if (input.searchUrlTemplate) {
    node.potentialAction = {
      "@type": "SearchAction",
      target: {
        "@type": "EntryPoint",
        urlTemplate: input.searchUrlTemplate,
      },
      "query-input": "required name=search_term_string",
    };
  }
  return node;
}

// ---- BreadcrumbList --------------------------------------------------------

function prettifySegment(segment: string): string {
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    // Malformed percent-escapes: the raw segment is still displayable.
  }
  const words = decoded.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  if (!words) return segment;
  return words
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function generateBreadcrumbList(
  pageUrl: string,
  siteName?: string,
): JsonLdNode {
  let url: URL;
  try {
    url = new URL(pageUrl);
  } catch {
    return {
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: siteName ?? pageUrl },
      ],
    };
  }
  const items: JsonLdNode[] = [
    {
      "@type": "ListItem",
      position: 1,
      name: siteName ?? url.hostname,
      item: `${url.origin}/`,
    },
  ];
  let trail = "";
  for (const segment of url.pathname.split("/").filter(Boolean)) {
    trail += `/${segment}`;
    items.push({
      "@type": "ListItem",
      position: items.length + 1,
      name: prettifySegment(segment),
      item: `${url.origin}${trail}`,
    });
  }
  return { "@type": "BreadcrumbList", itemListElement: items };
}

// ---- FAQPage ---------------------------------------------------------------

interface FaqQuestionInput {
  question: string;
  answer: string;
}

export interface FaqPageInput {
  mainEntity: FaqQuestionInput[];
  url?: string;
}

export function generateFaqPage(input: FaqPageInput): JsonLdNode {
  return assignDefined(
    {
      "@type": "FAQPage",
      mainEntity: input.mainEntity.map((entry) => ({
        "@type": "Question",
        name: entry.question,
        acceptedAnswer: { "@type": "Answer", text: entry.answer },
      })),
    },
    { url: input.url },
  );
}

// ---- Document assembly -----------------------------------------------------

export function buildGraphDocument(nodes: JsonLdNode[]): {
  "@context": string;
  "@graph": JsonLdNode[];
} {
  return { "@context": "https://schema.org", "@graph": nodes };
}

/**
 * Serialize for embedding inside `<script type="application/ld+json">`.
 * `<` can only appear inside JSON strings, so replacing every `<` with
 * the JSON escape `\u003c` makes a `</script` breakout impossible while
 * parsing back to the identical value.
 */
export function serializeJsonLdForScript(
  document: JsonLdNode | JsonLdNode[],
): string {
  return (JSON.stringify(document, null, 2) ?? "null").replaceAll(
    "<",
    "\\u003c",
  );
}

// ---- Ports of schema_generate.py ------------------------------------------

export interface ReservationInput {
  provider: string;
  startTime: string;
  kind?: string;
  endTime?: string;
  partySize?: number;
  reservationId?: string;
  reservationForName?: string;
  customerName?: string;
  customerEmail?: string;
}

export function generateReservation(input: ReservationInput): JsonLdNode {
  const kind = input.kind ?? "FoodEstablishmentReservation";
  const node = assignDefined(
    {
      "@type": kind,
      reservationStatus: "https://schema.org/ReservationConfirmed",
      provider: { "@type": "Organization", name: input.provider },
      reservationFor: {
        "@type":
          kind === "FoodEstablishmentReservation"
            ? "FoodEstablishment"
            : "Place",
        name: input.reservationForName ?? input.provider,
      },
      startTime: input.startTime,
    },
    {
      endTime: input.endTime,
      partySize: input.partySize,
      reservationId: input.reservationId,
    },
  );
  if (input.customerName || input.customerEmail) {
    node.underName = assignDefined(
      { "@type": "Person" },
      { name: input.customerName, email: input.customerEmail },
    );
  }
  return node;
}

export interface OrderActionInput {
  merchant: string;
  orderUrl: string;
  name?: string;
  acceptedPaymentMethods?: string[];
  deliveryMethods?: string[];
}

export function generateOrderAction(input: OrderActionInput): JsonLdNode {
  return assignDefined(
    {
      "@type": "OrderAction",
      name: input.name ?? "Order online",
      target: {
        "@type": "EntryPoint",
        urlTemplate: input.orderUrl,
        inLanguage: "en-US",
        actionPlatform: [
          "https://schema.org/DesktopWebPlatform",
          "https://schema.org/MobileWebPlatform",
        ],
      },
      deliveryMethod: input.deliveryMethods ?? [
        "https://schema.org/OnSitePickup",
        "https://schema.org/ParcelService",
      ],
      priceSpecification: {
        "@type": "PriceSpecification",
        eligibleTransactionVolume: {
          "@type": "PriceSpecification",
          minPrice: 0,
          priceCurrency: "USD",
        },
      },
      merchant: { "@type": "Organization", name: input.merchant },
    },
    {
      acceptedPaymentMethod: input.acceptedPaymentMethods?.map((method) => ({
        "@type": "PaymentMethod",
        name: method,
      })),
    },
  );
}

export interface DiscussionPostingInput {
  headline: string;
  author: string;
  url: string;
  datePublished: string;
  text?: string;
  dateModified?: string;
  commentCount?: number;
  interactionCounts?: Record<string, number>;
}

export function generateDiscussionForumPosting(
  input: DiscussionPostingInput,
): JsonLdNode {
  return assignDefined(
    {
      "@type": "DiscussionForumPosting",
      headline: input.headline,
      author: { "@type": "Person", name: input.author },
      datePublished: input.datePublished,
      url: input.url,
      mainEntityOfPage: { "@type": "WebPage", "@id": input.url },
    },
    {
      text: input.text,
      dateModified: input.dateModified,
      commentCount: input.commentCount,
      interactionStatistic: input.interactionCounts
        ? Object.entries(input.interactionCounts).map(([kind, count]) => ({
            "@type": "InteractionCounter",
            interactionType: `https://schema.org/${kind}`,
            userInteractionCount: count,
          }))
        : undefined,
    },
  );
}

export interface ProfilePageInput {
  name: string;
  url: string;
  description?: string;
  sameAs?: string[];
  knowsAbout?: string[];
  worksFor?: string;
  image?: string;
  jobTitle?: string;
}

export function generateProfilePage(input: ProfilePageInput): JsonLdNode {
  const mainEntity = assignDefined(
    { "@type": "Person", name: input.name, url: input.url },
    {
      description: input.description,
      sameAs: input.sameAs ? [...input.sameAs] : undefined,
      knowsAbout: input.knowsAbout ? [...input.knowsAbout] : undefined,
      worksFor: input.worksFor
        ? { "@type": "Organization", name: input.worksFor }
        : undefined,
      image: input.image,
      jobTitle: input.jobTitle,
    },
  );
  return { "@type": "ProfilePage", mainEntity, url: input.url };
}
