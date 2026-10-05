import { normalizeAndValidateStartUrl } from "./url-policy";
import { resolvePageContent } from "./render-page";
import type { PageAnalysis } from "./types";
import { AppError } from "@/server/lib/errors";

const FETCH_USER_AGENT = "OpenSEO-Audit/1.0";
const FETCH_TIMEOUT_MS = 30_000;
const FETCH_MAX_BYTES = 1024 * 1024;

export interface AnalyzedPage {
  finalUrl: string;
  html: string;
  analysis: PageAnalysis;
  spaShell: boolean;
  statusCode: number;
  responseTimeMs: number;
}

async function fetchBoundedHtml(url: string): Promise<{
  html: string;
  statusCode: number;
  responseTimeMs: number;
}> {
  const startedAt = Date.now();
  const response = await fetch(url, {
    headers: {
      "User-Agent": FETCH_USER_AGENT,
      Accept: "text/html,application/xhtml+xml",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const responseTimeMs = Date.now() - startedAt;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/html")) {
    await response.body?.cancel();
    throw new AppError("VALIDATION_ERROR", "URL did not return HTML");
  }
  if (!response.body) {
    return { html: "", statusCode: response.status, responseTimeMs };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let bytesRead = 0;
  try {
    while (bytesRead < FETCH_MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = FETCH_MAX_BYTES - bytesRead;
      const chunk =
        value.byteLength > remaining ? value.subarray(0, remaining) : value;
      bytesRead += chunk.byteLength;
      parts.push(decoder.decode(chunk, { stream: true }));
      if (bytesRead >= FETCH_MAX_BYTES) {
        await reader.cancel();
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  parts.push(decoder.decode());
  return {
    html: parts.join(""),
    statusCode: response.status,
    responseTimeMs,
  };
}

/**
 * Shared single-page fetch pipeline: SSRF-validated start URL, bounded HTML
 * read, Googlebot re-fetch for app shells, then analysis. Used by the page
 * audit and content-grade services so both read the same body.
 */
export async function fetchAnalyzedPage(url: string): Promise<AnalyzedPage> {
  // Throws VALIDATION_ERROR / CRAWL_TARGET_BLOCKED on bad or unsafe targets.
  const finalUrl = await normalizeAndValidateStartUrl(url);
  const { html, statusCode, responseTimeMs } = await fetchBoundedHtml(finalUrl);

  const resolved = await resolvePageContent({
    url: finalUrl,
    rawHtml: html,
    fetch: (probeUrl, init) => fetch(probeUrl, init),
  });

  const { analyzeHtml } = await import("./page-analyzer");
  const analysis = analyzeHtml(
    resolved.html,
    finalUrl,
    statusCode,
    responseTimeMs,
  );

  return {
    finalUrl,
    html: resolved.html,
    analysis,
    spaShell: resolved.spaShell,
    statusCode,
    responseTimeMs,
  };
}
