/**
 * Prerender/app-shell detection for the audit crawl — the browserless port of
 * claude-seo's `render_page.py` auto mode.
 *
 * This worker has no browser binding, so instead of executing JavaScript we
 * re-fetch a detected shell once as Googlebot. Sites using dynamic rendering
 * (Prerender.io, Rendertron, ...) serve fully rendered HTML to Googlebot and a
 * bare shell to everyone else; comparing the two responses decides which body
 * the analysis should use.
 */

/**
 * Page-fetch timeout (30s, `fetch_page.py`'s default), shared by the crawl's
 * raw fetch and the Googlebot re-fetch. Chunk safety under CRAWL_CHUNK_STEP
 * (5 minutes): fetches stop launching at the chunk's 90s soft deadline, so the
 * worst page spends 30s on the raw fetch plus at most one more 30s probe (shell
 * pages only), leaving ~2.5 minutes for persistence — no step timeout change.
 */
export const PAGE_FETCH_TIMEOUT_MS = 30_000;

const GOOGLEBOT_USER_AGENT = "Googlebot/2.1 (+http://www.google.com/bot.html)";

/**
 * Visible-text budget below which a document counts as sparse: ~60 words ≈
 * 400 characters, the same boundary render_page.py uses before it calls a
 * marked document a shell. Filled server-rendered pages clear it comfortably.
 */
const SPARSE_TEXT_WORDS = 60;
/**
 * Extra words (plus a doubling) that make a Googlebot body worth adopting
 * even when it still reads as a shell — e.g. a prerender-lite response that
 * keeps the mount element but ships headings and a little text the raw body
 * didn't have.
 */
const SUBSTANTIAL_TEXT_WORDS = 30;

/** Framework mount points, from render_page.py's shell markers. */
const MOUNT_IDS = ["root", "app", "__next", "__nuxt", "___gatsby", "q-app"];
const MOUNT_ELEMENT_PATTERN = new RegExp(
  `<[a-z][a-z0-9-]*[^<>]*\\s+id\\s*=\\s*(?:["'](?:${MOUNT_IDS.join(
    "|",
  )})["']|(?:${MOUNT_IDS.join("|")})(?=[\\s>]))`,
  "i",
);

const NON_VISIBLE_BLOCK_PATTERN =
  /<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
/**
 * An unterminated script/style swallows the rest of the document per the HTML
 * parsing algorithm, so leftover openers hide real markup — strip them to the
 * end after the paired blocks are gone.
 */
const UNTERMINATED_BLOCK_PATTERN =
  /<(script|style|noscript|template)\b[^>]*>[\s\S]*$/i;
const HTML_COMMENT_PATTERN = /<!--[\s\S]*?-->/g;
const TAG_PATTERN = /<[^>]+>/g;
const WHITESPACE_PATTERN = /\s+/g;
const HEADING_PATTERN = /<h[1-6][\s>]/i;
const SCRIPT_SRC_PATTERN = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;

/**
 * Same 1 MiB bound as the crawl's raw read (its MAX_HTML_BYTES). Kept local:
 * importing it from the workflow helper would create an import cycle, since
 * that module resolves page content through this one.
 */
const MAX_PROBE_BYTES = 1024 * 1024;

function stripNonVisible(html: string): string {
  return html
    .replace(NON_VISIBLE_BLOCK_PATTERN, " ")
    .replace(UNTERMINATED_BLOCK_PATTERN, " ")
    .replace(HTML_COMMENT_PATTERN, " ");
}

/**
 * Visible text inside <body>, lowercased for boundary matching (word counts
 * are case-insensitive). No <body> region counts as no text, matching
 * render_page.py — head-only documents are shells by definition.
 */
function visibleBodyText(strippedHtml: string): string {
  const lower = strippedHtml.toLowerCase();
  const bodyStart = lower.indexOf("<body");
  const bodyEnd = lower.lastIndexOf("</body>");
  if (bodyStart === -1 || bodyEnd <= bodyStart) return "";
  return strippedHtml
    .slice(bodyStart, bodyEnd)
    .replace(TAG_PATTERN, " ")
    .replace(WHITESPACE_PATTERN, " ")
    .trim();
}

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * True when the document loads an external script file, resolving relative
 * srcs against the page URL so `assets/app.js` counts while `data:`/inline
 * scripts do not.
 */
function hasScriptBundle(html: string, pageUrl: string): boolean {
  for (const match of html.matchAll(SCRIPT_SRC_PATTERN)) {
    try {
      const resolved = new URL(match[1], pageUrl);
      if (resolved.protocol === "http:" || resolved.protocol === "https:") {
        return true;
      }
    } catch {
      // A src this page URL cannot resolve is not a script bundle.
    }
  }
  return false;
}

/**
 * True when the raw HTML is a JavaScript app shell: a framework mount element
 * with essentially no server-rendered text, or no headings at all alongside a
 * script bundle. Conservative on purpose — a filled SSR page that keeps
 * `<div id="root">` must not be flagged, because flagging it would report a
 * rendering problem the site doesn't have.
 */
export function detectSpaShell(html: string, pageUrl: string): boolean {
  if (!html) return false;
  const markup = stripNonVisible(html);
  const words = countWords(visibleBodyText(markup));
  if (words >= SPARSE_TEXT_WORDS) return false;
  if (MOUNT_ELEMENT_PATTERN.test(markup)) return true;
  return !HEADING_PATTERN.test(markup) && hasScriptBundle(html, pageUrl);
}

/** Bounded body read, mirroring the crawl's raw reader (see MAX_PROBE_BYTES). */
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

/**
 * Resolve which HTML the analysis should read for one crawled URL: raw first,
 * with exactly one Googlebot re-fetch when — and only when — the raw body is a
 * shell that the re-fetch improves on. `fetch` is injected so the crawl can
 * pace the probe through its throttle and tests can drive the flow.
 */
export async function resolvePageContent(input: {
  url: string;
  rawHtml: string;
  fetch: typeof fetch;
}): Promise<{
  html: string;
  rendered: "raw" | "googlebot";
  spaShell: boolean;
}> {
  if (!detectSpaShell(input.rawHtml, input.url)) {
    return { html: input.rawHtml, rendered: "raw", spaShell: false };
  }

  const keepRaw = () => ({
    html: input.rawHtml,
    rendered: "raw" as const,
    spaShell: true,
  });

  let probe: Response;
  try {
    probe = await input.fetch(input.url, {
      headers: {
        "User-Agent": GOOGLEBOT_USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
      },
      // Manual, like the crawl's raw fetch: a redirect here is a chain hop,
      // and chains are capped where the frontier follows them. A non-HTML or
      // failed probe simply leaves the shell verdict in place.
      redirect: "manual",
      signal: AbortSignal.timeout(PAGE_FETCH_TIMEOUT_MS),
    });
  } catch {
    return keepRaw();
  }

  const contentType = probe.headers.get("content-type") ?? "";
  if (!probe.ok || !contentType.includes("text/html")) {
    await probe.body?.cancel();
    return keepRaw();
  }

  const candidate = await readTextUpTo(probe, MAX_PROBE_BYTES);
  if (!candidate.trim()) return keepRaw();

  const candidateIsShell = detectSpaShell(candidate, input.url);
  const candidateWords = countWords(
    visibleBodyText(stripNonVisible(candidate)),
  );
  const rawWords = countWords(visibleBodyText(stripNonVisible(input.rawHtml)));
  const substantiallyMoreText =
    candidateWords - rawWords >= SUBSTANTIAL_TEXT_WORDS &&
    candidateWords >= rawWords * 2;

  if (candidateIsShell && !substantiallyMoreText) return keepRaw();
  return {
    html: candidate,
    rendered: "googlebot",
    spaShell: candidateIsShell,
  };
}
