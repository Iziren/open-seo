/**
 * Optional Google PageSpeed / CrUX API clients.
 *
 * PSI is free and usable unauthenticated (a key only raises quota); CrUX
 * requires a key. Both are pure pass-through fetchers: all scoring and
 * interpretation lives in `lib/audit/perf-psi`, `perf-crux`, and `perf-lcp`.
 * Callers gate on `PAGESPEED_API_KEY` / `GOOGLE_API_KEY`; tests inject
 * `fetchImpl` and never touch the network.
 */

export const PSI_ENDPOINT =
  "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";
export const CRUX_RECORD_ENDPOINT =
  "https://chromeuxreport.googleapis.com/v1/records:queryRecord";
export const CRUX_HISTORY_ENDPOINT =
  "https://chromeuxreport.googleapis.com/v1/records:queryHistoryRecord";

export interface GoogleApiCallOptions {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function resolveApiKey(
  explicit: string | undefined,
  name: string,
): string | undefined {
  if (explicit) return explicit;
  // Guarded for Cloudflare Workers, where `process` is undefined.
  const fromProcess =
    typeof process !== "undefined" ? process.env?.[name] : undefined;
  return fromProcess || undefined;
}

function isPublicHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

async function postJson(
  endpoint: string,
  body: Record<string, unknown>,
  apiKey: string | undefined,
  options: GoogleApiCallOptions,
  timeoutMs: number,
): Promise<unknown> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const url = apiKey
    ? `${endpoint}?key=${encodeURIComponent(apiKey)}`
    : endpoint;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (response.status === 404) {
      throw new Error(
        "No CrUX data for this target. The site likely has insufficient Chrome traffic volume for eligibility.",
      );
    }
    if (response.status === 429) {
      throw new Error(
        "CrUX API rate limit exceeded (150 QPM shared). Wait and retry.",
      );
    }
    if (!response.ok) {
      throw new Error(
        `CrUX API error ${response.status}: ${(await response.text()).slice(0, 300)}`,
      );
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchPsi(
  url: string,
  options: GoogleApiCallOptions & {
    strategy?: "mobile" | "desktop";
    categories?: string[];
  } = {},
): Promise<unknown> {
  if (!isPublicHttpUrl(url)) {
    throw new Error("Invalid URL. Only http/https URLs are accepted.");
  }
  const apiKey = resolveApiKey(options.apiKey, "PAGESPEED_API_KEY");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const params = new URLSearchParams({
    url,
    strategy: (options.strategy ?? "mobile").toUpperCase(),
  });
  for (const category of options.categories ?? [
    "PERFORMANCE",
    "ACCESSIBILITY",
    "BEST_PRACTICES",
    "SEO",
  ]) {
    params.append("category", category);
  }
  if (apiKey) params.set("key", apiKey);
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? 120_000,
  );
  try {
    const response = await fetchImpl(`${PSI_ENDPOINT}?${params.toString()}`, {
      signal: controller.signal,
    });
    if (response.status === 429) {
      throw new Error("PSI rate limit exceeded. Wait and retry.");
    }
    if (response.status === 400) {
      throw new Error(
        `Invalid URL or parameters: ${(await response.text()).slice(0, 300)}`,
      );
    }
    if (!response.ok) {
      throw new Error(
        `PSI API error ${response.status}: ${(await response.text()).slice(0, 300)}`,
      );
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function queryCruxRecord(
  urlOrOrigin: string,
  options: GoogleApiCallOptions & {
    formFactor?: string;
    metrics?: string[];
  } = {},
): Promise<unknown> {
  if (!isPublicHttpUrl(urlOrOrigin)) {
    throw new Error("Invalid URL. Only http/https URLs are accepted.");
  }
  const apiKey = resolveApiKey(options.apiKey, "GOOGLE_API_KEY");
  if (!apiKey) {
    throw new Error("CrUX API requires an API key (GOOGLE_API_KEY).");
  }
  const body: Record<string, unknown> = { url: urlOrOrigin };
  if (options.formFactor) body["formFactor"] = options.formFactor.toUpperCase();
  if (options.metrics) body["metrics"] = options.metrics;
  return postJson(
    CRUX_RECORD_ENDPOINT,
    body,
    apiKey,
    options,
    options.timeoutMs ?? 30_000,
  );
}

async function queryCruxHistory(
  urlOrOrigin: string,
  options: GoogleApiCallOptions & { formFactor?: string } = {},
): Promise<unknown> {
  if (!isPublicHttpUrl(urlOrOrigin)) {
    throw new Error("Invalid URL. Only http/https URLs are accepted.");
  }
  const apiKey = resolveApiKey(options.apiKey, "GOOGLE_API_KEY");
  if (!apiKey) {
    throw new Error("CrUX API requires an API key (GOOGLE_API_KEY).");
  }
  const body: Record<string, unknown> = { url: urlOrOrigin };
  if (options.formFactor) body["formFactor"] = options.formFactor.toUpperCase();
  return postJson(
    CRUX_HISTORY_ENDPOINT,
    body,
    apiKey,
    options,
    options.timeoutMs ?? 30_000,
  );
}

// Frozen literal per house style; never a class.
export const GooglePageSpeedService = {
  fetchPsi,
  queryCruxRecord,
  queryCruxHistory,
} as const;
