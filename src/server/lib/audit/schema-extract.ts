/**
 * JSON-LD extraction: pull every `<script type="application/ld+json">` body
 * out of an HTML string, parse it without ever throwing, and index the
 * top-level entities by type.
 *
 * The page analyzer deliberately only records that structured data exists
 * (it must stay a streaming tokenizer to bound memory), so the actual JSON-LD
 * payload is parsed here, over the same HTML the crawl already holds.
 */
import { Parser } from "htmlparser2";
import { z } from "zod";

/** Entity types surfaced in the extraction index for audit/MCP consumers. */
export const INDEXED_SCHEMA_TYPES = [
  "Product",
  "Organization",
  "BreadcrumbList",
  "FAQPage",
  "Article",
  "WebSite",
] as const;

export type IndexedSchemaType = (typeof INDEXED_SCHEMA_TYPES)[number];

/** A top-level JSON-LD node with `@type` normalized to a string array. */
export interface JsonLdEntity {
  types: string[];
  value: Record<string, unknown>;
}

/**
 * One script tag's result. Malformed scripts are reported as `{ ok: false }`
 * rather than thrown, so a single broken tag can't sink a whole page audit.
 */
export type SchemaScriptResult =
  | {
      ok: true;
      scriptIndex: number;
      /** Document-level `@context` (null when the root carries none). */
      context: unknown;
      entities: JsonLdEntity[];
    }
  | { ok: false; scriptIndex: number; error: string };

export type SchemaIndex = Record<IndexedSchemaType, JsonLdEntity[]>;

export interface SchemaExtraction {
  scripts: SchemaScriptResult[];
  /** Every top-level entity across all scripts, in document order. */
  entities: JsonLdEntity[];
  index: SchemaIndex;
}

const jsonObjectSchema = z.looseObject({});

function asObject(value: unknown): Record<string, unknown> | null {
  const parsed = jsonObjectSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

const JSON_LD_TYPE_PREFIX = "application/ld+json";

/**
 * Bodies of every inline JSON-LD script, in document order. External
 * (`src=`) scripts carry no inline JSON-LD to parse, so they are skipped.
 */
function collectScriptBodies(html: string): string[] {
  const bodies: string[] = [];
  let buffer: string[] | null = null;
  const parser = new Parser({
    onopentag(name, attribs) {
      if (buffer !== null || name !== "script" || "src" in attribs) return;
      const type = attribs["type"];
      if (type && type.trim().toLowerCase().startsWith(JSON_LD_TYPE_PREFIX)) {
        buffer = [];
      }
    },
    ontext(text) {
      if (buffer !== null) buffer.push(text);
    },
    onclosetag(name) {
      if (name !== "script" || buffer === null) return;
      bodies.push(buffer.join(""));
      buffer = null;
    },
  });
  parser.write(html);
  parser.end();
  return bodies;
}

// ---- Shared type helpers (also consumed by schema-validate) ---------------

/** `@type` as a string array: string, array, and missing all normalized. */
export function nodeTypes(node: Record<string, unknown>): string[] {
  const raw = node["@type"];
  if (typeof raw === "string") return [raw];
  if (Array.isArray(raw)) {
    return raw.filter(
      (entry: unknown): entry is string => typeof entry === "string",
    );
  }
  return [];
}

export function hasType(node: Record<string, unknown>, type: string): boolean {
  return nodeTypes(node).includes(type);
}

function toEntity(value: Record<string, unknown>): JsonLdEntity {
  return { types: nodeTypes(value), value };
}

type EntityListResult = { entities: JsonLdEntity[] } | { error: string };

/** Normalize a root array or `@graph` (object or array) into entities. */
function toEntityList(source: unknown, label: string): EntityListResult {
  const items = Array.isArray(source) ? source : [source];
  const entities: JsonLdEntity[] = [];
  for (const [i, item] of items.entries()) {
    const object = asObject(item);
    if (object === null) {
      return {
        error: `${label ? `${label}[` : "["}${i}] is not a JSON object`,
      };
    }
    entities.push(toEntity(object));
  }
  return { entities };
}

/**
 * Parse one JSON-LD script body. Handles the three shapes publishers emit:
 * a single object, an array of objects, and an object with `@graph`.
 */
export function parseJsonLdScript(
  raw: string,
  scriptIndex: number,
): SchemaScriptResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      scriptIndex,
      error: `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const rootObject = asObject(parsed);
  if (rootObject !== null) {
    const graph = rootObject["@graph"];
    if (graph === undefined) {
      return {
        ok: true,
        scriptIndex,
        context: rootObject["@context"] ?? null,
        entities: [toEntity(rootObject)],
      };
    }
    const result = toEntityList(graph, "@graph");
    if ("error" in result)
      return { ok: false, scriptIndex, error: result.error };
    return {
      ok: true,
      scriptIndex,
      context: rootObject["@context"] ?? null,
      entities: result.entities,
    };
  }
  if (Array.isArray(parsed)) {
    const result = toEntityList(parsed, "");
    if ("error" in result)
      return { ok: false, scriptIndex, error: result.error };
    // Array roots have no document-level object to carry `@context`.
    return { ok: true, scriptIndex, context: null, entities: result.entities };
  }
  return {
    ok: false,
    scriptIndex,
    error: "JSON-LD script root must be an object or an array",
  };
}

export function buildSchemaIndex(entities: JsonLdEntity[]): SchemaIndex {
  const index: SchemaIndex = {
    Product: [],
    Organization: [],
    BreadcrumbList: [],
    FAQPage: [],
    Article: [],
    WebSite: [],
  };
  for (const entity of entities) {
    for (const type of INDEXED_SCHEMA_TYPES) {
      if (entity.types.includes(type)) index[type].push(entity);
    }
  }
  return index;
}

/** Extract, parse, and index every JSON-LD script in an HTML document. */
export function extractSchemaFromHtml(html: string): SchemaExtraction {
  const scripts = collectScriptBodies(html).map((body, scriptIndex) =>
    parseJsonLdScript(body, scriptIndex),
  );
  const entities = scripts.flatMap((script) =>
    script.ok ? script.entities : [],
  );
  return { scripts, entities, index: buildSchemaIndex(entities) };
}
