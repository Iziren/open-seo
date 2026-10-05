import { Parser } from "htmlparser2";

// Kept out of the service's static module graph (the audit parser is imported
// dynamically for the same reason): htmlparser2 should only load when a drift
// capture actually runs, not in every isolate's baseline heap.

/**
 * Extract `application/ld+json` script bodies from HTML as parsed JSON.
 *
 * Malformed blocks are dropped — they cannot be compared as structured data,
 * and a parse failure at capture time must not fail the whole snapshot.
 * Uses the tokenizer (not a DOM) for the same memory reasons as
 * src/server/lib/audit/page-analyzer.ts.
 */
export function extractJsonLdBlocks(html: string): unknown[] {
  const blocks: unknown[] = [];
  let collecting = false;
  let buffer = "";

  const parser = new Parser({
    onopentag(name, attribs) {
      if (name === "script" && isJsonLdType(attribs.type)) {
        collecting = true;
        buffer = "";
      }
    },
    ontext(text) {
      if (collecting) buffer += text;
    },
    onclosetag(name) {
      if (name !== "script" || !collecting) return;
      collecting = false;
      const parsed = parseJsonOrNull(buffer);
      if (parsed !== null) blocks.push(parsed);
    },
  });
  parser.end(html);
  return blocks;
}

function isJsonLdType(type: string | undefined): boolean {
  return (type ?? "").trim().toLowerCase() === "application/ld+json";
}

function parseJsonOrNull(raw: string): unknown {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed;
  } catch {
    return null;
  }
}
