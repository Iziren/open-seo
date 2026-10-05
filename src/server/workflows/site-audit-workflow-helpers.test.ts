import { afterEach, describe, expect, it, vi } from "vitest";
import { createCrawlThrottle } from "@/server/lib/audit/crawl-throttle";
import { crawlPage } from "@/server/workflows/site-audit-workflow-helpers";

const PAGE_URL = "https://example.com/page";
const PAGE_HTML =
  "<html><head><title>A page</title></head><body><h1>A page</h1></body></html>";

/**
 * Answer each fetch with the next reply, repeating the last one. Every call
 * builds a fresh Response: a body can only be read (or cancelled) once.
 */
function stubFetch(...replies: Array<{ status: number; retryAfter?: string }>) {
  let index = 0;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    const reply = replies[Math.min(index++, replies.length - 1)];
    return new Response(PAGE_HTML, {
      status: reply.status,
      headers: {
        "content-type": "text/html",
        ...(reply.retryAfter ? { "retry-after": reply.retryAfter } : {}),
      },
    });
  });
}

function crawl() {
  return crawlPage(
    PAGE_URL,
    0,
    false,
    createCrawlThrottle(Date.now() + 90_000),
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("crawlPage", () => {
  it("waits out the server's Retry-After and keeps the retried page", async () => {
    vi.useFakeTimers();
    const fetchMock = stubFetch(
      { status: 429, retryAfter: "5" },
      { status: 200 },
    );

    const crawled = crawl();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2_000);
    const page = await crawled;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(page?.fetchClass).toBe("ok");
    expect(page?.title).toBe("A page");
    // Recovered, but the crawl window should still slow down after it.
    expect(page?.rateLimited).toBe(true);
  });

  it("holds every other fetch in the chunk while one URL's 429 pause runs", async () => {
    vi.useFakeTimers();
    const fetched: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      fetched.push(new Request(input).url);
      // Only the first request to the first URL is refused.
      const refused = fetched.length === 1;
      return new Response(PAGE_HTML, {
        status: refused ? 429 : 200,
        headers: {
          "content-type": "text/html",
          ...(refused ? { "retry-after": "5" } : {}),
        },
      });
    });
    const throttle = createCrawlThrottle(Date.now() + 90_000);

    const first = crawlPage(`${PAGE_URL}/first`, 0, false, throttle);
    await vi.advanceTimersByTimeAsync(0);
    const second = crawlPage(`${PAGE_URL}/second`, 0, false, throttle);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(fetched).toEqual([`${PAGE_URL}/first`]);

    await vi.advanceTimersByTimeAsync(3_000);
    const pages = await Promise.all([first, second]);
    expect(fetched).toHaveLength(3);
    expect(pages.map((page) => page?.fetchClass)).toEqual(["ok", "ok"]);
  });

  it("records a page the site keeps rate limiting, without calling it blocked", async () => {
    vi.useFakeTimers();
    const fetchMock = stubFetch({ status: 429, retryAfter: "1" });

    const crawled = crawl();
    await vi.advanceTimersByTimeAsync(30_000);
    const page = await crawled;

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(page?.fetchClass).toBe("rate_limited");
  });

  it("recovers concurrent pages without a burst after sixty seconds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const starts: number[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      starts.push(Date.now());
      return new Response(PAGE_HTML, {
        status: Date.now() < 60_000 ? 429 : 200,
        headers: { "content-type": "text/html", "retry-after": "60" },
      });
    });
    const throttle = createCrawlThrottle(90_000);
    const pages = Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        crawlPage(`${PAGE_URL}/${i}`, 0, false, throttle),
      ),
    );
    await vi.advanceTimersByTimeAsync(59_999);
    expect(starts).toEqual([0]);
    await vi.runAllTimersAsync();
    expect((await pages).map((page) => page?.fetchClass)).toEqual(
      Array(5).fill("ok"),
    );
    expect(starts).toEqual([0, 60_000, 62_000, 64_000, 66_000, 68_000]);
  });

  it("defers the refused URL when its cooldown exceeds the chunk deadline", async () => {
    vi.useFakeTimers();
    const fetchMock = stubFetch({ status: 429, retryAfter: "600" });
    const throttle = createCrawlThrottle(Date.now() + 90_000);
    expect(await crawlPage(PAGE_URL, 0, false, throttle)).toBeNull();
    expect(
      await crawlPage(`${PAGE_URL}/unvisited`, 0, false, throttle),
    ).toBeNull();
    expect(throttle.stopped).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("records a final 429 when the requested wait exceeds the audit's cooldown budget", async () => {
    vi.useFakeTimers();
    const fetchMock = stubFetch({ status: 429, retryAfter: "3600" });
    const throttle = createCrawlThrottle(Date.now() + 90_000);
    expect((await crawlPage(PAGE_URL, 0, false, throttle))?.fetchClass).toBe(
      "rate_limited",
    );
    expect(throttle.stopped).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry a 403 — bot protection is not a speed limit", async () => {
    const fetchMock = stubFetch({ status: 403 });

    const page = await crawl();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(page?.fetchClass).toBe("blocked");
  });

  it("preserves extracted metadata and nested values when releasing the HTML", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          `<html><head>
            <title>Example &amp; café 🌱</title>
            <meta name="description" content="Example description &amp; more">
            <meta name="robots" content="noindex">
            <meta property="og:title" content="Example social title 🌱">
            <meta property="og:description" content="Example description">
            <meta property="og:image" content="/social.png">
            <link rel="canonical" href="/canonical">
            <link rel="alternate" hreflang="en" href="/en">
            <script type="application/ld+json">{}</script>
          </head><body><h1>Hello</h1><h2>World</h2>
            <img src="/photo.png" alt="Example photo 🌱"><img src="/missing.png">
            <img alt="">
            <a href="/next" rel="nofollow">More &amp; more 🌱</a>
            <a href="https://other.example/">External</a>
          </body></html>`,
          {
            headers: {
              "content-type": "text/html",
              "x-robots-tag": "nofollow",
              link: '<https://example.com/header>; rel="canonical"',
            },
          },
        ),
      ),
    );

    const page = await crawlPage(
      "https://example.com/",
      2,
      true,
      createCrawlThrottle(Date.now() + 90_000),
    );

    expect(page).toMatchObject({
      url: "https://example.com/",
      statusCode: 200,
      fetchClass: "ok",
      redirectUrl: null,
      title: "Example & café 🌱",
      metaDescription: "Example description & more",
      canonicalUrl: "https://example.com/canonical",
      robotsMeta: "noindex",
      xRobotsTag: "nofollow",
      headerCanonicalUrl: "https://example.com/header",
      ogTitle: "Example social title 🌱",
      ogDescription: "Example description",
      ogImage: "/social.png",
      h1Count: 1,
      h2Count: 1,
      h3Count: 0,
      headingOrder: [1, 2],
      isHtml: true,
      imagesTotal: 3,
      imagesMissingAlt: 1,
      images: [
        { src: "/photo.png", alt: "Example photo 🌱" },
        { src: "/missing.png", alt: null },
        { src: null, alt: "" },
      ],
      links: [
        {
          targetUrl: "https://example.com/next",
          anchor: "More & more 🌱",
          isInternal: true,
          isNofollow: true,
        },
        {
          targetUrl: "https://other.example/",
          anchor: "External",
          isInternal: false,
          isNofollow: false,
        },
      ],
      hasStructuredData: true,
      hreflangTags: ["en"],
      isIndexable: false,
      crawlDepth: 2,
      inSitemap: true,
    });
    expect(page?.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(page?.htmlBytes).toBeGreaterThan(0);
  });
});

describe("crawlPage content and schema enrichment", () => {
  function stubHtml(html: string) {
    return vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(html, {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    );
  }

  const BODY_WORDS = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");

  function doc(headExtra = "") {
    return `<html><head><title>A reasonably lengthed page title</title>
<meta name="description" content="A description long enough to clear seventy characters for this test page.">
${headExtra}</head><body><h1>Page heading</h1><p>${BODY_WORDS}</p></body></html>`;
  }

  it("scores content and summarizes NLP on every analyzed page", async () => {
    stubHtml(doc());

    const page = await crawl();

    expect(page?.contentScore).toEqual(expect.any(Number));
    expect(page?.contentScore).toBeGreaterThanOrEqual(0);
    expect(page?.contentScore).toBeLessThanOrEqual(100);
    expect(page?.contentFindings).toEqual(expect.any(Array));
    expect(page?.schemaStatus).toBe("missing");
    expect(page?.schemaTypes).toEqual([]);
    expect(page?.nlpSummary?.tokenCount).toEqual(expect.any(Number));
    expect(page?.nlpSummary?.overOptimized).toEqual(expect.any(Boolean));
  });

  it("marks unparseable JSON-LD invalid with compact findings", async () => {
    stubHtml(
      doc(
        `<script type="application/ld+json">{"@context": "https://schema.org", "@type": "Product", "name": "Kettle"`,
      ),
    );

    const page = await crawl();

    expect(page?.hasStructuredData).toBe(true);
    expect(page?.schemaStatus).toBe("invalid");
    expect(page?.schemaFindings?.[0]?.code).toBe("jsonld-parse-error");
  });

  it("marks parseable non-Product markup valid without merchant policy", async () => {
    stubHtml(
      doc(
        `<script type="application/ld+json">{"@context": "https://schema.org", "@type": "Organization", "name": "Acme", "url": "https://example.com"}</script>`,
      ),
    );

    const page = await crawl();

    expect(page?.schemaStatus).toBe("valid");
    expect(page?.schemaTypes).toEqual(["Organization"]);
  });

  it("validates Product blocks against merchant-listing requirements", async () => {
    stubHtml(
      doc(
        `<script type="application/ld+json">{"@context": "https://schema.org", "@type": "Product", "name": "Kettle"}</script>`,
      ),
    );

    const page = await crawl();

    expect(page?.schemaStatus).toBe("invalid");
    expect(
      page?.schemaFindings?.some((finding) =>
        finding.code.startsWith("missing-product-"),
      ),
    ).toBe(true);
  });
});
