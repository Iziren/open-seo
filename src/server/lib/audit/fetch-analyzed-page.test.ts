import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchAnalyzedPage, type AnalyzedPage } from "./fetch-analyzed-page";

function dohEmpty() {
  return new Response(JSON.stringify({ Status: 0, Answer: [] }), {
    status: 200,
    headers: { "content-type": "application/dns-json" },
  });
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("cloudflare-dns.com")) return dohEmpty();
      return new Response(
        `<html><head><title>Tote</title></head><body><h1>Tote</h1>` +
          `<p>${"A sturdy tote. ".repeat(30)}</p></body></html>`,
        { status: 200, headers: { "content-type": "text/html" } },
      );
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchAnalyzedPage", () => {
  it("validates, fetches, and analyzes one URL", async () => {
    const page: AnalyzedPage = await fetchAnalyzedPage(
      "https://example.com/products/tote",
    );

    expect(page.finalUrl).toBe("https://example.com/products/tote");
    expect(page.statusCode).toBe(200);
    expect(page.analysis.title).toBe("Tote");
    expect(page.analysis.wordCount).toBeGreaterThan(0);
    expect(page.spaShell).toBe(false);
    expect(page.responseTimeMs).toBeGreaterThanOrEqual(0);
  });

  it("blocks SSRF targets before fetching", async () => {
    await expect(
      fetchAnalyzedPage("http://169.254.169.254/"),
    ).rejects.toMatchObject({ code: "CRAWL_TARGET_BLOCKED" });
  });

  it("rejects non-HTML responses", async () => {
    vi.mocked(fetch).mockImplementation(
      async (input: string | URL | Request) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes("cloudflare-dns.com")) return dohEmpty();
        return new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    );

    await expect(
      fetchAnalyzedPage("https://example.com/data.json"),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});
