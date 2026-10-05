import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  env: {},
  DurableObject: class {
    kind = "mock";
  },
}));

import { PageAuditService } from "./PageAuditService";

const HTML =
  `<html><head><title>Canvas Tote — Example Store</title>` +
  `<meta name="description" content="A sturdy canvas tote for everyday carry, stitched to last."></head>` +
  `<body><h1>Canvas Tote</h1><p>${"Sturdy stitched canvas with leather handles. ".repeat(30)}</p>` +
  `<img src="/tote.jpg" alt="Canvas tote"><a href="/collections/bags">Bags</a></body></html>`;

function dohEmpty() {
  return new Response(JSON.stringify({ Status: 0, Answer: [] }), {
    status: 200,
    headers: { "content-type": "application/dns-json" },
  });
}

function htmlResponse(html: string, status = 200) {
  return new Response(html, {
    status,
    headers: { "content-type": "text/html" },
  });
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("cloudflare-dns.com")) return dohEmpty();
      return htmlResponse(HTML);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PageAuditService.auditPage", () => {
  it("audits a page end to end with scores and issues", async () => {
    const result = await PageAuditService.auditPage({
      projectId: "project-1",
      url: "https://example.com/products/canvas-tote",
    });

    expect(result.finalUrl).toBe("https://example.com/products/canvas-tote");
    expect(result.statusCode).toBe(200);
    expect(result.title).toBe("Canvas Tote — Example Store");
    expect(result.wordCount).toBeGreaterThan(0);
    expect(result.contentScore).toBeGreaterThanOrEqual(0);
    expect(result.contentScore).toBeLessThanOrEqual(100);
    expect(result.schemaStatus).toBe("missing");
    expect(result.geoScore).toBeGreaterThanOrEqual(0);
    expect(result.geoScore).toBeLessThanOrEqual(100);
    expect(result.spaShell).toBe(false);
    expect(Array.isArray(result.issues)).toBe(true);
  });

  it("reports invalid structured data as an issue", async () => {
    vi.mocked(fetch).mockImplementation(
      async (input: string | URL | Request) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes("cloudflare-dns.com")) return dohEmpty();
        return htmlResponse(
          `<html><head><title>T</title></head><body><h1>T</h1>` +
            `<script type="application/ld+json">{"@type": broken</script>` +
            `<p>${"Words. ".repeat(40)}</p></body></html>`,
        );
      },
    );

    const result = await PageAuditService.auditPage({
      projectId: "project-1",
      url: "https://example.com/broken-schema",
    });

    expect(result.schemaStatus).toBe("invalid");
    expect(
      result.issues.some((i) => i.issueType === "invalid-structured-data"),
    ).toBe(true);
  });

  it("blocks SSRF targets", async () => {
    await expect(
      PageAuditService.auditPage({
        projectId: "project-1",
        url: "http://169.254.169.254/latest/meta-data/",
      }),
    ).rejects.toMatchObject({ code: "CRAWL_TARGET_BLOCKED" });
  });

  it("rejects non-HTML responses", async () => {
    vi.mocked(fetch).mockImplementation(
      async (input: string | URL | Request) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes("cloudflare-dns.com")) return dohEmpty();
        return new Response('{"a":1}', {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    );

    await expect(
      PageAuditService.auditPage({
        projectId: "project-1",
        url: "https://example.com/data.json",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});
