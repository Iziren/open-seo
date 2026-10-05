/**
 * JSON-LD validation, in two layers:
 *
 * 1. Structural — Zod schemas for the types this repo generates; they catch
 *    wrong-shaped values (a numeric `name`, string `offers`) before policy.
 * 2. Semantic — merchant-listing and rich-result policy ported from
 *    scripts/schema_ecommerce_validate.py, plus context/price/URL rules that
 *    parse fine but still disqualify a rich feature.
 *
 * Findings mirror the Python severities: errors ← Critical/High (fail the
 * page), warnings ← Medium, recommendations ← Info. `ok` is false only when
 * an error exists, matching the Python exit-code behavior.
 */
import { z } from "zod";
import { hasType, nodeTypes } from "./schema-extract";

export interface SchemaFinding {
  /** Machine-readable rule id, e.g. "missing-product-image". */
  code: string;
  message: string;
}

export interface SchemaValidationResult {
  ok: boolean;
  errors: SchemaFinding[];
  warnings: SchemaFinding[];
  recommendations: SchemaFinding[];
}

export interface SchemaValidateOptions {
  /** EPREL scope: require energyEfficiencyClass on every Product. */
  requireEuEnergy?: boolean;
}

// Types Google retired June 2025 — generating them yields a Critical finding.
const DEPRECATED_TYPES: Record<string, string> = {
  Vehicle: "Vehicle Listing rich result retired June 2025.",
  VehicleListing: "Vehicle Listing rich result retired June 2025.",
  ClaimReview: "Claim Review rich result retired June 2025.",
  EstimatedSalary: "Estimated Salary rich result retired June 2025.",
  LearningVideo: "Learning Video rich result retired June 2025.",
  Course: "Course Info carousel retired June 2025; verify your use-case.",
  SpecialAnnouncement: "Special Announcement rich result deprecated July 2025.",
};

const REQUIRED_PRODUCT_FIELDS = ["name", "image", "offers"];
const RECOMMENDED_PRODUCT_FIELDS = ["description"];
const RECOMMENDED_OFFER_FIELDS = ["price", "priceCurrency", "availability"];
const RETURN_POLICY_FIELDS = ["applicableCountry", "returnPolicyCategory"];
const SHIPPING_FIELDS = ["shippingDestination", "deliveryTime"];
const URL_FIELDS = ["url", "image", "logo", "urlTemplate", "item"];

const VALID_AVAILABILITY = new Set(
  (
    "Discontinued InStock InStoreOnly LimitedAvailability OnlineOnly " +
    "OutOfStock PreOrder PreSale SoldOut"
  ).split(" "),
);

// ---- Structural schemas (layer 1) -----------------------------------------

const str = z.string();
const obj = z.looseObject({});
const objOrArray = z.union([obj, z.array(obj)]);
const idValue = z.union([str, z.number()]);
const imageValue = z.union([str, z.array(z.union([str, obj])), obj]);

const productSchema = z.looseObject({
  name: str.optional(),
  description: str.optional(),
  image: imageValue.optional(),
  sku: idValue.optional(),
  gtin: idValue.optional(),
  mpn: idValue.optional(),
  brand: z.union([str, obj]).optional(),
  url: str.optional(),
  offers: objOrArray.optional(),
  aggregateRating: obj.optional(),
  hasMerchantReturnPolicy: objOrArray.optional(),
  shippingDetails: objOrArray.optional(),
  hasMemberProgram: objOrArray.optional(),
  energyEfficiencyClass: z.union([str, obj]).optional(),
});

const offerSchema = z.looseObject({
  name: str.optional(),
  price: z.union([z.number(), str]).optional(),
  priceCurrency: str.optional(),
  availability: str.optional(),
  url: str.optional(),
  priceSpecification: objOrArray.optional(),
});

const STRUCTURAL_TYPES: Record<string, { code: string; schema: z.ZodType }> = {
  Product: { code: "product", schema: productSchema },
  Offer: { code: "offer", schema: offerSchema },
  Organization: {
    code: "organization",
    schema: z.looseObject({
      name: str,
      url: str.optional(),
      logo: z.union([str, obj]).optional(),
      sameAs: z.union([str, z.array(str)]).optional(),
    }),
  },
  WebSite: {
    code: "website",
    schema: z.looseObject({
      name: str,
      url: str.optional(),
      potentialAction: objOrArray.optional(),
    }),
  },
  BreadcrumbList: {
    code: "breadcrumb-list",
    schema: z.looseObject({ itemListElement: z.array(obj).min(1) }),
  },
  FAQPage: {
    code: "faq-page",
    schema: z.looseObject({
      mainEntity: z
        .array(z.looseObject({ name: str, acceptedAnswer: objOrArray }))
        .min(1),
    }),
  },
};

// ---- Value helpers ---------------------------------------------------------

type Emitter = (code: string, message: string) => void;

function emitter(list: SchemaFinding[]): Emitter {
  return (code, message) => list.push({ code, message });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Collect every object in a JSON-LD document, parents before children. */
function collectNodes(value: unknown, out: Record<string, unknown>[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectNodes(item, out);
    return;
  }
  if (!isRecord(value)) return;
  out.push(value);
  for (const child of Object.values(value)) collectNodes(child, out);
}

/** Python's `value in (None, "", [])` emptiness test. */
function isEmptyValue(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    value === "" ||
    (Array.isArray(value) && value.length === 0)
  );
}

function toOfferList(value: unknown): Record<string, unknown>[] {
  const candidates = Array.isArray(value) ? value : [value];
  return candidates.filter(isRecord);
}

function isAbsoluteUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isParsablePrice(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0;
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  // Tolerate thousands grouping ("1,299.00") but not locale decimals.
  const normalized = /^\d{1,3}(,\d{3})+(\.\d+)?$/.test(trimmed)
    ? trimmed.replaceAll(",", "")
    : trimmed;
  const price = Number(normalized);
  return Number.isFinite(price) && price >= 0;
}

function isValidAvailability(value: string): boolean {
  if (!value.includes("/")) return VALID_AVAILABILITY.has(value);
  try {
    const url = new URL(value);
    return (
      url.hostname === "schema.org" &&
      VALID_AVAILABILITY.has(url.pathname.slice(1))
    );
  } catch {
    return false;
  }
}

// ---- Layer 1: structural checks -------------------------------------------

function runStructuralChecks(
  nodes: Record<string, unknown>[],
  errors: SchemaFinding[],
): void {
  for (const node of nodes) {
    for (const type of nodeTypes(node)) {
      const entry = STRUCTURAL_TYPES[type];
      if (!entry) continue;
      const result = entry.schema.safeParse(node);
      if (result.success) continue;
      const issues = result.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ");
      emitter(errors)(`structural-${entry.code}`, issues);
    }
  }
}

// ---- Layer 2: semantic checks ---------------------------------------------

function checkDeprecatedTypes(
  nodes: Record<string, unknown>[],
  errors: SchemaFinding[],
): void {
  const seen = new Set<string>();
  const push = emitter(errors);
  for (const node of nodes) {
    for (const type of nodeTypes(node)) {
      const reason = DEPRECATED_TYPES[type];
      if (reason && !seen.has(type)) {
        seen.add(type);
        push("deprecated-type", `@type='${type}': ${reason}`);
      }
    }
  }
}

function checkAbsoluteUrls(
  nodes: Record<string, unknown>[],
  errors: SchemaFinding[],
): void {
  const push = emitter(errors);
  for (const node of nodes) {
    for (const field of URL_FIELDS) {
      const value = node[field];
      if (typeof value === "string" && value && !isAbsoluteUrl(value))
        push("relative-url", `${field} must be an absolute URL: '${value}'`);
    }
    const sameAs = node["sameAs"];
    const ids = typeof sameAs === "string" ? [sameAs] : sameAs;
    if (Array.isArray(ids))
      for (const id of ids) {
        if (typeof id === "string" && id && !isAbsoluteUrl(id))
          push("relative-url", `sameAs entry '${id}' must be absolute.`);
      }
  }
}

function checkOffer(
  offer: Record<string, unknown>,
  errors: SchemaFinding[],
  warnings: SchemaFinding[],
): void {
  const error = emitter(errors);
  const warn = emitter(warnings);
  if (hasType(offer, "AggregateOffer"))
    error(
      "merchant-listing-offer-type",
      "Use @type='Offer', not AggregateOffer.",
    );
  else if (!hasType(offer, "Offer"))
    error("merchant-listing-offer-type", "offers.@type must be 'Offer'.");
  for (const field of RECOMMENDED_OFFER_FIELDS) {
    if (isEmptyValue(offer[field]))
      warn(`recommended-offer-${field}`, `Offer is missing '${field}'.`);
  }
  const price = offer["price"];
  if (!isEmptyValue(price) && !isParsablePrice(price)) {
    error("price-not-parsable", `Offer price '${String(price)}' is invalid.`);
  }
  const availability = offer["availability"];
  if (typeof availability === "string" && !isValidAvailability(availability)) {
    error("invalid-availability", `'${availability}' is not ItemAvailability.`);
  }
}

function hasLoyaltyPricing(
  node: Record<string, unknown>,
  offers: Record<string, unknown>[],
): boolean {
  if (!isEmptyValue(node["hasMemberProgram"])) return true;
  return offers.some((offer) => {
    const spec = offer["priceSpecification"];
    const specs = Array.isArray(spec) ? spec : [spec];
    return specs.some(
      (entry) =>
        isRecord(entry) &&
        entry["@type"] === "UnitPriceSpecification" &&
        !isEmptyValue(entry["validForMemberTier"]),
    );
  });
}

function checkProduct(
  node: Record<string, unknown>,
  errors: SchemaFinding[],
  warnings: SchemaFinding[],
  recommendations: SchemaFinding[],
  options: SchemaValidateOptions,
): void {
  const error = emitter(errors);
  const warn = emitter(warnings);
  const hint = emitter(recommendations);
  for (const field of REQUIRED_PRODUCT_FIELDS) {
    if (isEmptyValue(node[field]))
      error(`missing-product-${field}`, `Product is missing '${field}'.`);
  }
  for (const field of RECOMMENDED_PRODUCT_FIELDS) {
    if (isEmptyValue(node[field]))
      warn(
        `recommended-product-${field}`,
        `Product should include '${field}'.`,
      );
  }

  const offers = toOfferList(node["offers"]);
  for (const offer of offers) checkOffer(offer, errors, warnings);

  // Product-level value wins when present, else the first offer's (the
  // Python port's `product or offers[0]` fallback).
  const first = offers[0];
  const policy = !isEmptyValue(node["hasMerchantReturnPolicy"])
    ? node["hasMerchantReturnPolicy"]
    : first?.["hasMerchantReturnPolicy"];
  if (isEmptyValue(policy)) {
    warn("missing-return-policy", "Product lacks hasMerchantReturnPolicy.");
  } else if (isRecord(policy)) {
    for (const field of RETURN_POLICY_FIELDS) {
      if (policy[field] === undefined)
        warn(`return-policy-${field}`, `MerchantReturnPolicy lacks ${field}.`);
    }
  }

  const shipping = !isEmptyValue(node["shippingDetails"])
    ? node["shippingDetails"]
    : first?.["shippingDetails"];
  if (isEmptyValue(shipping)) {
    warn("missing-shipping-details", "Product lacks shippingDetails.");
  } else if (isRecord(shipping)) {
    for (const field of SHIPPING_FIELDS) {
      if (shipping[field] === undefined)
        warn(`shipping-${field}`, `ShippingDetails lacks ${field}.`);
    }
  }

  if (!hasLoyaltyPricing(node, offers))
    warn("missing-member-program", "No MemberProgram or loyalty pricing.");
  if (options.requireEuEnergy && node["energyEfficiencyClass"] === undefined)
    error("missing-eu-energy-class", "EU mode requires energyEfficiencyClass.");

  const rating = node["aggregateRating"];
  if (isRecord(rating)) {
    if (isEmptyValue(rating["ratingValue"]))
      error("aggregate-rating-missing-rating-value", "ratingValue missing.");
    const counts = ["reviewCount", "ratingCount"];
    if (counts.every((key) => isEmptyValue(rating[key])))
      error("aggregate-rating-missing-review-count", "reviewCount missing.");
  }

  if (["sku", "gtin", "mpn"].every((field) => isEmptyValue(node[field])))
    hint("missing-product-identifier", "Add sku, gtin, or mpn.");
  if (isEmptyValue(node["brand"])) hint("missing-product-brand", "Add brand.");
  if (isEmptyValue(node["url"])) hint("missing-product-url", "Add url.");
}

function checkOrphanOffers(
  nodes: Record<string, unknown>[],
  products: Record<string, unknown>[],
  errors: SchemaFinding[],
): void {
  const attached = new Set<Record<string, unknown>>();
  for (const product of products)
    for (const offer of toOfferList(product["offers"])) attached.add(offer);
  const push = emitter(errors);
  for (const node of nodes) {
    if (!hasType(node, "Offer") && !hasType(node, "AggregateOffer")) continue;
    if (!attached.has(node))
      push("orphan-offer", "Offer is not attached to any Product.");
  }
}

function runSemanticChecks(
  nodes: Record<string, unknown>[],
  errors: SchemaFinding[],
  warnings: SchemaFinding[],
  recommendations: SchemaFinding[],
  options: SchemaValidateOptions,
): void {
  checkDeprecatedTypes(nodes, errors);
  const products = nodes.filter((node) => hasType(node, "Product"));
  const error = emitter(errors);
  if (products.length === 0)
    error("missing-product", 'No @type="Product" block found.');
  if (products.length > 1)
    error("duplicate-product", `${products.length} Product blocks conflict.`);
  for (const product of products)
    checkProduct(product, errors, warnings, recommendations, options);
  checkOrphanOffers(nodes, products, errors);
  checkAbsoluteUrls(nodes, errors);
  const hint = emitter(recommendations);
  if (products.length > 0 && !nodes.some((n) => hasType(n, "ProductGroup")))
    hint("no-product-group", "Consider ProductGroup for size/colour variants.");
}

// ---- Entry point -----------------------------------------------------------

export function validateSchema(
  payload: unknown,
  options: SchemaValidateOptions = {},
): SchemaValidationResult {
  const errors: SchemaFinding[] = [];
  const warnings: SchemaFinding[] = [];
  const recommendations: SchemaFinding[] = [];
  const done = (): SchemaValidationResult => ({
    ok: errors.length === 0,
    errors,
    warnings,
    recommendations,
  });
  const push = emitter(errors);

  if (!isRecord(payload) && !Array.isArray(payload)) {
    push("not-jsonld-document", "Payload must be an object or array.");
    return done();
  }

  // @context has to sit on the document root (or every array entry) or
  // consumers parse the nodes against no vocabulary at all.
  if (isRecord(payload)) {
    if (payload["@context"] === undefined)
      push("missing-context", 'JSON-LD document has no "@context".');
  } else {
    const entries: unknown[] = Array.isArray(payload) ? payload : [];
    for (const entry of entries)
      if (isRecord(entry) && entry["@context"] === undefined)
        push("missing-context", "Array entry has no @context.");
  }

  const nodes: Record<string, unknown>[] = [];
  collectNodes(payload, nodes);
  runStructuralChecks(nodes, errors);
  runSemanticChecks(nodes, errors, warnings, recommendations, options);
  return done();
}
