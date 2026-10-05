import { AppError } from "@/server/lib/errors";
import { normalizeAndValidateStartUrl } from "@/server/lib/audit/url-policy";

// Same identity and timeouts as the audit crawler (fetchPage in
// site-audit-workflow-helpers.ts): drift captures should look to sites like
// the crawl they accompany.
const DRIFT_USER_AGENT = "OpenSEO-Audit/1.0";
const FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECT_HOPS = 5;
// The first 1 MiB contains every SEO attribute we capture; capping keeps one
// pathological page from blowing the isolate heap (same cap as the audit).
const MAX_HTML_BYTES = 1024 * 1024;

// The subset of response headers stored in seo_drift_snapshots.headers_json —
// indexability and canonical signals that live in headers, plus freshness
// markers a site owner wants to see change.
const HEADERS_OF_INTEREST = [
  "content-type",
  "x-robots-tag",
  "link",
  "last-modified",
  "etag",
  "cache-control",
];

type DriftPage = {
  finalUrl: string;
  statusCode: number;
  headers: Record<string, string>;
  html: string;
  responseTimeMs: number;
};

/**
 * Fetch one URL for drift capture, re-running the full SSRF validation on
 * every redirect hop (url-policy.ts) so neither the user's input nor a
 * redirect target can reach a private/internal host. Redirects are followed
 * manually for exactly that reason — never with `redirect: "follow"`.
 */
export async function fetchDriftPage(rawUrl: string): Promise<DriftPage> {
  const startedAt = Date.now();
  let current = await normalizeAndValidateStartUrl(rawUrl);

  for (let hop = 0; ; hop++) {
    const response = await fetchWithTimeout(current);
    const location = isRedirect(response.status)
      ? response.headers.get("location")
      : null;
    if (!location) {
      return finalize(response, current, Date.now() - startedAt);
    }
    if (hop >= MAX_REDIRECT_HOPS) {
      throw new AppError(
        "UPSTREAM_UNAVAILABLE",
        `Too many redirects fetching ${rawUrl}`,
      );
    }
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      throw new AppError(
        "UPSTREAM_UNAVAILABLE",
        `Invalid redirect target from ${current}`,
      );
    }
    await response.body?.cancel();
    // Full validation again: a redirect is attacker-controllable input.
    current = await normalizeAndValidateStartUrl(next.toString());
  }
}

async function fetchWithTimeout(url: string): Promise<Response> {
  try {
    return await fetch(url, {
      headers: {
        "User-Agent": DRIFT_USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
      },
      // Manual on purpose: each hop is validated above before the next fetch.
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new AppError(
      "UPSTREAM_UNAVAILABLE",
      `Failed to fetch ${url}: ${detail}`,
    );
  }
}

async function finalize(
  response: Response,
  finalUrl: string,
  responseTimeMs: number,
): Promise<DriftPage> {
  const headers: Record<string, string> = {};
  for (const name of HEADERS_OF_INTEREST) {
    const value = response.headers.get(name);
    if (value) headers[name] = value;
  }

  const contentType = response.headers.get("content-type") ?? "";
  const isHtml = contentType.includes("text/html");
  const html = isHtml
    ? await readTextUpTo(response, MAX_HTML_BYTES)
    : await cancelBody(response);

  return {
    finalUrl,
    statusCode: response.status,
    headers,
    html,
    responseTimeMs,
  };
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

async function cancelBody(response: Response): Promise<string> {
  await response.body?.cancel();
  return "";
}

/** Read at most `maxBytes` of the body, then release the reader/connection. */
async function readTextUpTo(
  response: Response,
  maxBytes: number,
): Promise<string> {
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let bytesRead = 0;

  try {
    while (bytesRead < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;

      const remaining = maxBytes - bytesRead;
      const chunk =
        value.byteLength > remaining ? value.subarray(0, remaining) : value;
      bytesRead += chunk.byteLength;
      parts.push(decoder.decode(chunk, { stream: true }));

      if (bytesRead >= maxBytes) {
        await reader.cancel();
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }

  parts.push(decoder.decode());
  return parts.join("");
}
