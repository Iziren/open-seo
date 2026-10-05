import { z } from "zod";
import { fetchAnalyzedPage } from "@/server/lib/audit/fetch-analyzed-page";
import { extractSchemaFromHtml } from "@/server/lib/audit/schema-extract";
import {
  buildGraphDocument,
  generateBreadcrumbList,
  generateFaqPage,
  generateOrganization,
  generateProduct,
  generateWebsite,
  serializeJsonLdForScript,
} from "@/server/lib/audit/schema-generate";
import {
  validateSchema,
  type SchemaValidationResult,
} from "@/server/lib/audit/schema-validate";
import { toJsonValue, type JsonValue } from "@/server/lib/audit/json-value";

export const schemaTypeSchema = z.enum([
  "Product",
  "Organization",
  "Website",
  "BreadcrumbList",
  "FAQPage",
]);
export type SchemaType = z.infer<typeof schemaTypeSchema>;

const offerSchema = z.object({
  price: z.union([z.number(), z.string()]),
  priceCurrency: z.string().min(1),
  availability: z.string().optional(),
  url: z.string().optional(),
  name: z.string().optional(),
  priceValidUntil: z.string().optional(),
});

const productDataSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  image: z.array(z.string()).optional(),
  sku: z.string().optional(),
  gtin: z.string().optional(),
  mpn: z.string().optional(),
  brand: z
    .union([
      z.string(),
      z.object({ name: z.string(), url: z.string().optional() }),
    ])
    .optional(),
  url: z.string().optional(),
  offers: z.union([offerSchema, z.array(offerSchema)]).optional(),
  aggregateRating: z
    .object({
      ratingValue: z.number(),
      reviewCount: z.number().int().min(0),
      bestRating: z.number().optional(),
      worstRating: z.number().optional(),
    })
    .optional(),
});

const organizationDataSchema = z.object({
  name: z.string().min(1),
  url: z.string().optional(),
  logo: z.string().optional(),
  sameAs: z.array(z.string()).optional(),
  description: z.string().optional(),
});

const websiteDataSchema = z.object({
  name: z.string().min(1),
  url: z.string().min(1),
  searchUrlTemplate: z.string().optional(),
});

const breadcrumbDataSchema = z.object({
  pageUrl: z.string().min(1),
  siteName: z.string().optional(),
});

const faqDataSchema = z.object({
  mainEntity: z
    .array(z.object({ question: z.string().min(1), answer: z.string().min(1) }))
    .min(1),
  url: z.string().optional(),
});

export interface GeneratedSchema {
  type: SchemaType;
  /** The @graph document as JSON-safe data (for APIs and storage). */
  document: JsonValue;
  /** Serialized and escaped for direct embedding in a script element. */
  script: string;
  /** Self-check: what we generate must validate clean. */
  validation: SchemaValidationResult;
}

function wrapGenerated(
  type: SchemaType,
  build: () => Record<string, unknown>,
): GeneratedSchema {
  const document = buildGraphDocument([build()]);
  const raw = validateSchema(document);
  // validateSchema encodes page-level merchant policy (a page without
  // Product fails), but single non-Product nodes are generated to join a
  // page @graph that carries Product separately — the missing-product error
  // would false-positive on every BreadcrumbList, FAQPage, Organization,
  // and Website we emit. All other rules still apply unchanged.
  const validation: SchemaValidationResult =
    type === "Product"
      ? raw
      : {
          ...raw,
          errors: raw.errors.filter(
            (finding) => finding.code !== "missing-product",
          ),
          ok: raw.errors.every((finding) => finding.code === "missing-product"),
        };
  const normalized = toJsonValue(document);
  if (
    normalized === null ||
    typeof normalized !== "object" ||
    Array.isArray(normalized)
  ) {
    throw new Error("Generated schema did not normalize to a JSON object");
  }
  return {
    type,
    document: normalized,
    script: serializeJsonLdForScript(document),
    validation,
  };
}

function generateProductDocument(data: unknown): GeneratedSchema {
  const parsed = productDataSchema.parse(data);
  return wrapGenerated("Product", () => generateProduct(parsed));
}

function generateOrganizationDocument(data: unknown): GeneratedSchema {
  const parsed = organizationDataSchema.parse(data);
  return wrapGenerated("Organization", () => generateOrganization(parsed));
}

function generateWebsiteDocument(data: unknown): GeneratedSchema {
  const parsed = websiteDataSchema.parse(data);
  return wrapGenerated("Website", () => generateWebsite(parsed));
}

function generateBreadcrumbDocument(data: unknown): GeneratedSchema {
  const parsed = breadcrumbDataSchema.parse(data);
  return wrapGenerated("BreadcrumbList", () =>
    generateBreadcrumbList(parsed.pageUrl, parsed.siteName),
  );
}

function generateFaqDocument(data: unknown): GeneratedSchema {
  const parsed = faqDataSchema.parse(data);
  return wrapGenerated("FAQPage", () => generateFaqPage(parsed));
}

async function generate(input: {
  projectId: string;
  type: SchemaType;
  data: unknown;
}): Promise<GeneratedSchema> {
  switch (input.type) {
    case "Product":
      return generateProductDocument(input.data);
    case "Organization":
      return generateOrganizationDocument(input.data);
    case "Website":
      return generateWebsiteDocument(input.data);
    case "BreadcrumbList":
      return generateBreadcrumbDocument(input.data);
    case "FAQPage":
      return generateFaqDocument(input.data);
  }
}

function validate(input: {
  projectId: string;
  document: unknown;
}): SchemaValidationResult {
  return validateSchema(input.document);
}

async function extractFromUrl(input: {
  projectId: string;
  url: string;
}): Promise<{
  url: string;
  finalUrl: string;
  types: string[];
  scriptCount: number;
  validation: SchemaValidationResult;
}> {
  const { finalUrl, html } = await fetchAnalyzedPage(input.url);
  const extraction = extractSchemaFromHtml(html);
  const types = [
    ...new Set(extraction.entities.flatMap((entity) => entity.types)),
  ];
  const document = buildGraphDocument(
    extraction.entities.map((entity) => entity.value),
  );
  return {
    url: input.url,
    finalUrl,
    types,
    scriptCount: extraction.scripts.length,
    validation: validateSchema(document),
  };
}

export const SchemaService = {
  generate,
  validate,
  extractFromUrl,
} as const;
