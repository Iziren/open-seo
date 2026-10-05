// Pure comparison helpers: URL/JSON/text normalization that keeps cosmetic
// variance (scheme, www, trailing slashes, key order, whitespace, display
// truncation) out of the diff engine. No I/O.

import { sort } from "remeda";

export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * True when the two strings are identical or differ only by display
 * truncation: the longer one reaches the length at which SERP/capture
 * rendering cuts text off and the shorter is a pure prefix of it. Without
 * this, a title stored truncated at capture reads as drift on every compare.
 */
export function textEqualsIgnoringTruncation(
  a: string,
  b: string,
  truncationChars: number,
): boolean {
  if (a === b) return true;
  const shorter = a.length < b.length ? a : b;
  const longer = a.length < b.length ? b : a;
  if (!shorter) return false;
  return longer.length >= truncationChars && longer.startsWith(shorter);
}

/**
 * Normalize a canonical URL for equality checks: http→https, www-insensitive,
 * default ports stripped, fragment dropped, query sorted, trailing slash
 * removed (except the bare "/"). The classic canonical false positives are
 * `http://` vs `https://`, `www.` vs apex, and `/page` vs `/page/`.
 *
 * Returns null for absent/blank input and the lowercased raw text for
 * relative or non-http canonicals (which cannot be resolved without the page
 * URL — capture already resolves relatives before storing).
 */
export function normalizeCanonicalUrl(url: string | null): string | null {
  const trimmed = url?.trim();
  if (!trimmed) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return trimmed.toLowerCase();
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return trimmed.toLowerCase();
  }

  try {
    parsed.protocol = "https:";
    parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
    // The URL parser strips scheme-default ports already; these are the
    // cross-scheme leftovers (https://host:80, http://host:443).
    if (parsed.port === "80" || parsed.port === "443") parsed.port = "";
    parsed.hash = "";
    parsed.searchParams.sort();
    if (parsed.pathname !== "/" && parsed.pathname.endsWith("/")) {
      parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    }
  } catch {
    // A malformed host (e.g. "www.") makes URL setters throw; fall back to
    // raw comparison rather than crashing the whole compare.
    return trimmed.toLowerCase();
  }
  return parsed.toString();
}

/**
 * Stable JSON text with object keys sorted recursively, so two JSON-LD blocks
 * that differ only in key order canonicalize identically. Array order is
 * preserved — block/graph order can be semantically meaningful.
 */
export function canonicalizeJson(value: unknown): string {
  return JSON.stringify(sortJsonKeys(value));
}

function sortJsonKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((child: unknown) => sortJsonKeys(child));
  }
  if (value === null || typeof value !== "object") return value;
  const sorted: Record<string, unknown> = {};
  for (const [key, child] of sort(Object.entries(value), ([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    sorted[key] = sortJsonKeys(child);
  }
  return sorted;
}

/**
 * Ratcliff–Obershelp similarity in [0, 1] — the same metric as Python's
 * difflib.SequenceMatcher().ratio() used by the original drift rules: twice
 * the matched characters over the total length of both strings.
 */
export function similarityRatio(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
  return (2 * matchingCharacters(a, b)) / (a.length + b.length);
}

function matchingCharacters(a: string, b: string): number {
  const match = longestCommonSubstring(a, b);
  if (match.length === 0) return 0;
  let total = match.length;
  const aHead = a.slice(0, match.aStart);
  const bHead = b.slice(0, match.bStart);
  if (aHead && bHead) total += matchingCharacters(aHead, bHead);
  const aTail = a.slice(match.aStart + match.length);
  const bTail = b.slice(match.bStart + match.length);
  if (aTail && bTail) total += matchingCharacters(aTail, bTail);
  return total;
}

type CommonSubstring = { aStart: number; bStart: number; length: number };

function longestCommonSubstring(a: string, b: string): CommonSubstring {
  let best: CommonSubstring = { aStart: 0, bStart: 0, length: 0 };
  let previous = Array.from({ length: b.length + 1 }, () => 0);
  for (let i = 1; i <= a.length; i++) {
    const current = Array.from({ length: b.length + 1 }, () => 0);
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] !== b[j - 1]) continue;
      const length = previous[j - 1] + 1;
      current[j] = length;
      // Strict ">" keeps the earliest match on ties, matching difflib's
      // "longest, then earliest" selection so tests stay deterministic.
      if (length > best.length) {
        best = { aStart: i - length, bStart: j - length, length };
      }
    }
    previous = current;
  }
  return best;
}
