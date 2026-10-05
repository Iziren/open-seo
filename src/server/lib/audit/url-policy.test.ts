import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppError } from "@/server/lib/errors";
import {
  normalizeAndValidateStartUrl,
  resolveStartUrlRedirects,
  normalizeHost,
  canonicalizeObfuscatedIpv4,
  isCrawlableUrl,
} from "@/server/lib/audit/url-policy";

describe("normalizeAndValidateStartUrl", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("adds https when protocol is missing and strips hash", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ Status: 0, Answer: [] }), {
        status: 200,
        headers: { "content-type": "application/dns-json" },
      }),
    );

    await expect(
      normalizeAndValidateStartUrl("example.com/path#section"),
    ).resolves.toBe("https://example.com/path");
  });

  it("blocks localhost-like targets", async () => {
    await expect(
      normalizeAndValidateStartUrl("http://localhost:3000"),
    ).rejects.toMatchObject({
      code: "CRAWL_TARGET_BLOCKED",
    } satisfies Partial<AppError>);
  });

  it("blocks private ip targets", async () => {
    await expect(
      normalizeAndValidateStartUrl("http://192.168.0.10"),
    ).rejects.toMatchObject({
      code: "CRAWL_TARGET_BLOCKED",
    } satisfies Partial<AppError>);
  });

  it("rejects invalid URL input", async () => {
    await expect(
      normalizeAndValidateStartUrl("not a url"),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    } satisfies Partial<AppError>);
  });
});

const dnsOk = () =>
  new Response(JSON.stringify({ Status: 0, Answer: [] }), {
    status: 200,
    headers: { "content-type": "application/dns-json" },
  });
const redirect = (location: string) =>
  new Response(null, { status: 301, headers: { location } });

describe("resolveStartUrlRedirects", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Route probe fetches by URL; DoH lookups always resolve clean. */
  function stubFetch(routes: Record<string, () => Response>) {
    vi.mocked(fetch).mockImplementation((input) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("dns-query")) return Promise.resolve(dnsOk());
      const route = routes[url];
      return route
        ? Promise.resolve(route())
        : Promise.resolve(new Response(null, { status: 200 }));
    });
  }

  it("follows a cross-domain redirect to the real origin", async () => {
    stubFetch({
      "https://example.net/": () => redirect("https://example.com/"),
    });
    await expect(
      resolveStartUrlRedirects("https://example.net/"),
    ).resolves.toBe("https://example.com/");
  });

  it("follows an apex-to-www redirect chain", async () => {
    stubFetch({
      "https://example.com/": () => redirect("https://www.example.com/"),
    });
    await expect(
      resolveStartUrlRedirects("https://example.com/"),
    ).resolves.toBe("https://www.example.com/");
  });

  it("returns the original URL when the site does not redirect", async () => {
    stubFetch({});
    await expect(
      resolveStartUrlRedirects("https://example.com/"),
    ).resolves.toBe("https://example.com/");
  });

  it("returns the last URL when the probe fails", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("network down"));
    await expect(
      resolveStartUrlRedirects("https://example.com/"),
    ).resolves.toBe("https://example.com/");
  });

  it("stops after the hop limit on a redirect loop", async () => {
    stubFetch({
      "https://a.example/": () => redirect("https://b.example/"),
      "https://b.example/": () => redirect("https://a.example/"),
    });
    await expect(
      resolveStartUrlRedirects("https://a.example/"),
    ).resolves.toMatch(/^https:\/\/(a|b)\.example\/$/);
  });

  it("rejects redirects into blocked targets", async () => {
    stubFetch({
      "https://example.com/": () => redirect("http://192.168.0.10/"),
    });
    await expect(
      resolveStartUrlRedirects("https://example.com/"),
    ).rejects.toMatchObject({
      code: "CRAWL_TARGET_BLOCKED",
    } satisfies Partial<AppError>);
  });
});

describe("normalizeHost obfuscated IPv4 canonicalization", () => {
  it("canonicalizes decimal integer IPv4", () => {
    expect(normalizeHost("2130706433")).toBe("127.0.0.1");
    expect(normalizeHost("3232235521")).toBe("192.168.0.1");
  });

  it("canonicalizes hex IPv4", () => {
    expect(normalizeHost("0x7f000001")).toBe("127.0.0.1");
    expect(normalizeHost("0XC0A80001")).toBe("192.168.0.1");
  });

  it("canonicalizes octal IPv4", () => {
    expect(normalizeHost("017700000001")).toBe("127.0.0.1");
  });

  it("canonicalizes dotted hex IPv4", () => {
    expect(normalizeHost("0x7f.0.0.1")).toBe("127.0.0.1");
    expect(normalizeHost("0xC0.0xA8.0.1")).toBe("192.168.0.1");
  });

  it("canonicalizes dotted octal IPv4", () => {
    expect(normalizeHost("0177.0.0.1")).toBe("127.0.0.1");
  });

  it("canonicalizes dotted with leading zeros", () => {
    expect(normalizeHost("127.0.0.001")).toBe("127.0.0.1");
    expect(normalizeHost("192.168.000.001")).toBe("192.168.0.1");
  });

  it("canonicalizes short-form IPv4 (a.b)", () => {
    expect(normalizeHost("192.168")).toBe("192.168.0.0");
  });

  it("canonicalizes short-form IPv4 (a.b.c)", () => {
    expect(normalizeHost("192.168.1")).toBe("192.168.1.0");
  });

  it("returns original host for non-matching patterns", () => {
    expect(normalizeHost("example.com")).toBe("example.com");
    expect(normalizeHost("192.168.0.1")).toBe("192.168.0.1");
    expect(normalizeHost("::1")).toBe("::1");
  });

  it("canonicalizeObfuscatedIpv4 returns null for malformed input", () => {
    expect(canonicalizeObfuscatedIpv4("9999999999")).toBeNull();
    expect(canonicalizeObfuscatedIpv4("0xGGGGGGGG")).toBeNull();
    expect(canonicalizeObfuscatedIpv4("not.an.ip")).toBeNull();
  });
});

describe("SEO_LOCAL_TARGETS allowlist", () => {
  const originalEnv = process.env.SEO_LOCAL_TARGETS;

  afterEach(() => {
    process.env.SEO_LOCAL_TARGETS = originalEnv;
  });

  it("allows localhost when explicitly allowlisted", async () => {
    process.env.SEO_LOCAL_TARGETS = "localhost:3000";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ Status: 0, Answer: [] }), {
          status: 200,
          headers: { "content-type": "application/dns-json" },
        }),
      ),
    );

    await expect(
      normalizeAndValidateStartUrl("http://localhost:3000"),
    ).resolves.toBe("http://localhost:3000/");
  });

  it("allows 127.0.0.1 when explicitly allowlisted", async () => {
    process.env.SEO_LOCAL_TARGETS = "127.0.0.1";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ Status: 0, Answer: [] }), {
          status: 200,
          headers: { "content-type": "application/dns-json" },
        }),
      ),
    );

    await expect(
      normalizeAndValidateStartUrl("http://127.0.0.1:8080"),
    ).resolves.toBe("http://127.0.0.1:8080/");
  });

  it("blocks localhost when not allowlisted", async () => {
    process.env.SEO_LOCAL_TARGETS = "";
    await expect(
      normalizeAndValidateStartUrl("http://localhost:3000"),
    ).rejects.toMatchObject({ code: "CRAWL_TARGET_BLOCKED" });
  });

  it("never allows metadata endpoints even when allowlisted", async () => {
    process.env.SEO_LOCAL_TARGETS = "169.254.169.254";
    await expect(
      normalizeAndValidateStartUrl("http://169.254.169.254"),
    ).rejects.toMatchObject({ code: "CRAWL_TARGET_BLOCKED" });
  });

  it("respects port in allowlist entry", async () => {
    process.env.SEO_LOCAL_TARGETS = "localhost:3000";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ Status: 0, Answer: [] }), {
          status: 200,
          headers: { "content-type": "application/dns-json" },
        }),
      ),
    );

    await expect(
      normalizeAndValidateStartUrl("http://localhost:3000"),
    ).resolves.toBeTruthy();

    await expect(
      normalizeAndValidateStartUrl("http://localhost:4000"),
    ).rejects.toMatchObject({ code: "CRAWL_TARGET_BLOCKED" });
  });

  it("allows RFC 6598 (100.64/10) when allowlisted", async () => {
    process.env.SEO_LOCAL_TARGETS = "100.100.100.100";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ Status: 0, Answer: [] }), {
          status: 200,
          headers: { "content-type": "application/dns-json" },
        }),
      ),
    );

    await expect(
      normalizeAndValidateStartUrl("http://100.100.100.100"),
    ).resolves.toBeTruthy();
  });
});

describe("isCrawlableUrl SEO_LOCAL_TARGETS allowlist", () => {
  const originalEnv = process.env.SEO_LOCAL_TARGETS;

  afterEach(() => {
    process.env.SEO_LOCAL_TARGETS = originalEnv;
  });

  it("allows allowlisted local links mid-crawl", () => {
    process.env.SEO_LOCAL_TARGETS = "localhost:3000,127.0.0.1";
    expect(isCrawlableUrl("http://localhost:3000/next")).toBe(true);
    expect(isCrawlableUrl("http://127.0.0.1/next")).toBe(true);
  });

  it("blocks local links when not allowlisted", () => {
    process.env.SEO_LOCAL_TARGETS = "";
    expect(isCrawlableUrl("http://localhost:3000/next")).toBe(false);
    expect(isCrawlableUrl("http://127.0.0.1/next")).toBe(false);
    expect(isCrawlableUrl("http://192.168.1.10/admin")).toBe(false);
  });

  it("honours the port of the allowlist entry", () => {
    process.env.SEO_LOCAL_TARGETS = "localhost:3000";
    expect(isCrawlableUrl("http://localhost:3000/a")).toBe(true);
    expect(isCrawlableUrl("http://localhost:4000/a")).toBe(false);
  });

  it("never allows metadata endpoints mid-crawl", () => {
    process.env.SEO_LOCAL_TARGETS =
      "169.254.169.254,metadata.google.internal,0.0.0.0";
    expect(isCrawlableUrl("http://169.254.169.254/latest/meta-data/")).toBe(
      false,
    );
    expect(isCrawlableUrl("http://metadata.google.internal/")).toBe(false);
    expect(isCrawlableUrl("http://0.0.0.0/")).toBe(false);
  });

  it("still blocks non-http(s) and public-host-free URLs", () => {
    expect(isCrawlableUrl("ftp://example.com/file")).toBe(false);
    expect(isCrawlableUrl("not a url")).toBe(false);
    expect(isCrawlableUrl("https://example.com/page")).toBe(true);
  });
});
