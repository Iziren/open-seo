import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  env: {},
  DurableObject: class {
    kind = "mock";
  },
}));

import { ContentQualityService } from "./ContentQualityService";
import type { ContentGradeResult } from "./ContentQualityService";

const HTML =
  `<html><head><title>Canvas Tote — Example Store</title>` +
  `<meta name="description" content="A sturdy canvas tote for everyday carry, stitched to last."></head>` +
  `<body><h1>Canvas Tote</h1><p>${"Sturdy stitched canvas with leather handles. ".repeat(30)}</p></body></html>`;

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
      return new Response(HTML, {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ContentQualityService.gradeUrl", () => {
  it("grades a page with dimensions, findings, and readability", async () => {
    const result: ContentGradeResult = await ContentQualityService.gradeUrl({
      projectId: "project-1",
      url: "https://example.com/products/canvas-tote",
    });

    expect(result.finalUrl).toBe("https://example.com/products/canvas-tote");
    expect(result.overall).toBeGreaterThanOrEqual(0);
    expect(result.overall).toBeLessThanOrEqual(100);
    expect(Object.keys(result.dimensions)).toEqual(
      expect.arrayContaining([
        "trust",
        "experience",
        "expertise",
        "authority",
        "readability",
        "originality",
        "thinness",
      ]),
    );
    expect(Array.isArray(result.findings)).toBe(true);
    expect(result.readingEase).toEqual(expect.any(Number));
    expect(result.descriptionRestatesTitle).toBe(false);
  });

  it("flags templated copy", async () => {
    vi.mocked(fetch).mockImplementation(
      async (input: string | URL | Request) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes("cloudflare-dns.com")) return dohEmpty();
        return new Response(
          `<html><head><title>Buy now</title></head><body><h1>Buy now</h1>` +
            `<p>Lorem ipsum dolor sit amet. Try it free now. ${"Filler words here. ".repeat(30)}</p></body></html>`,
          { status: 200, headers: { "content-type": "text/html" } },
        );
      },
    );

    const result = await ContentQualityService.gradeUrl({
      projectId: "project-1",
      url: "https://example.com/thin",
    });

    const codes = result.findings.map((f) => f.code);
    expect(
      codes.some(
        (code) => code.includes("filler") || code.includes("placeholder"),
      ) ||
        result.placeholders.length > 0 ||
        result.stockCtas.length > 0,
    ).toBe(true);
  });

  it("blocks SSRF targets", async () => {
    await expect(
      ContentQualityService.gradeUrl({
        projectId: "project-1",
        url: "http://169.254.169.254/",
      }),
    ).rejects.toMatchObject({ code: "CRAWL_TARGET_BLOCKED" });
  });
});
