import { beforeEach, describe, expect, it, vi } from "vitest";
import { DriftService } from "./DriftService";

// Repository is mocked (no Workers runtime here); the fetch stub drives the
// real SSRF validation, redirect loop, and htmlparser2 extraction, so these
// tests exercise everything between a URL in and a stored snapshot out.

const mocks = vi.hoisted(() => ({
  createBaseline: vi.fn(),
  getBaseline: vi.fn(),
  insertSnapshots: vi.fn(),
  getSnapshotsForBaseline: vi.fn(),
  getSnapshotsForUrl: vi.fn(),
  getOpenChanges: vi.fn(),
  insertChanges: vi.fn(),
  resolveChanges: vi.fn(),
  getChangesForUrl: vi.fn(),
  getChangesForBaseline: vi.fn(),
}));

vi.mock("../repositories/DriftRepository", () => ({
  DriftRepository: mocks,
}));

/** Router stub: answers DoH probes with empty records, pages via `page`. */
function stubFetch(page: (url: string) => Response) {
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.startsWith("https://cloudflare-dns.com/")) {
      return new Response(JSON.stringify({ Status: 0, Answer: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return page(url);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function htmlResponse(
  html: string,
  options: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(html, {
    status: options.status ?? 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      ...options.headers,
    },
  });
}

type PageParts = {
  title?: string;
  description?: string;
  h1?: string;
  robots?: string;
  xRobots?: string;
  status?: number;
};

function pageHtml(parts: PageParts): string {
  const head = [
    parts.title === undefined ? "" : `<title>${parts.title}</title>`,
    parts.description
      ? `<meta name="description" content="${parts.description}">`
      : "",
    parts.robots ? `<meta name="robots" content="${parts.robots}">` : "",
  ].join("");
  const body = `${parts.h1 ? `<h1>${parts.h1}</h1>` : ""}<p>one two three four five six seven eight nine ten</p>`;
  return `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
}

function pageResponse(parts: PageParts): Response {
  const headers: Record<string, string> = {};
  if (parts.xRobots) headers["x-robots-tag"] = parts.xRobots;
  return htmlResponse(pageHtml(parts), { status: parts.status, headers });
}

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset();
});

describe("DriftService.captureBaseline", () => {
  it("rejects an empty URL list before touching the repository", async () => {
    await expect(
      DriftService.captureBaseline({ projectId: "p1", urls: [] }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(mocks.createBaseline).not.toHaveBeenCalled();
  });

  it("rejects blocked targets before any network call", async () => {
    const fetchMock = stubFetch(() => pageResponse({ title: "unused" }));

    await expect(
      DriftService.captureBaseline({
        projectId: "p1",
        urls: ["http://169.254.169.254/latest/meta-data/"],
      }),
    ).rejects.toMatchObject({ code: "CRAWL_TARGET_BLOCKED" });
    expect(mocks.createBaseline).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("captures attributes, deduplicates normalized URLs, and stores snapshots", async () => {
    stubFetch(() =>
      pageResponse({
        title: "Acme Tools",
        description: "Professional tools for every trade.",
        h1: "Welcome to Acme",
        xRobots: "index,follow",
      }),
    );

    const result = await DriftService.captureBaseline({
      projectId: "p1",
      name: "Week 39",
      // Same page: host case differs; normalization collapses the pair.
      urls: ["https://example.com/page", "https://EXAMPLE.com/page"],
    });

    expect(result.baseline).toMatchObject({ projectId: "p1", name: "Week 39" });
    expect(mocks.createBaseline).toHaveBeenCalledWith({
      id: result.baseline.id,
      projectId: "p1",
      name: "Week 39",
      createdAt: result.baseline.createdAt,
    });
    expect(result.snapshots).toHaveLength(1);
    expect(result.snapshots[0]).toMatchObject({
      url: "https://example.com/page",
      title: "Acme Tools",
      metaDescription: "Professional tools for every trade.",
      h1: "Welcome to Acme",
      statusCode: 200,
      indexable: true,
    });
    expect(result.snapshots[0].headersJson).toContain("text/html");
    expect(JSON.parse(result.snapshots[0].headersJson ?? "{}")).toMatchObject({
      "x-robots-tag": "index,follow",
    });
    expect(result.failures).toEqual([]);
    expect(mocks.insertSnapshots).toHaveBeenCalledWith([
      expect.objectContaining({
        baselineId: result.baseline.id,
        url: "https://example.com/page",
      }),
    ]);
  });

  it("derives a timestamped default name when none is given", async () => {
    stubFetch(() => pageResponse({ title: "Acme" }));

    const result = await DriftService.captureBaseline({
      projectId: "p1",
      urls: ["https://example.com/page"],
    });

    expect(result.baseline.name).toMatch(
      /^Baseline \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/,
    );
  });

  it("keeps the pages that captured when one URL fails to fetch", async () => {
    stubFetch((url) => {
      if (url.includes("/down")) throw new TypeError("network down");
      return pageResponse({ title: "Up" });
    });

    const result = await DriftService.captureBaseline({
      projectId: "p1",
      urls: ["https://example.com/up", "https://example.com/down"],
    });

    expect(result.snapshots.map((snapshot) => snapshot.url)).toEqual([
      "https://example.com/up",
    ]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.url).toBe("https://example.com/down");
    expect(result.failures[0]?.error).toContain("UPSTREAM_UNAVAILABLE");
  });

  it("re-validates redirect targets, refusing hops to internal hosts", async () => {
    stubFetch(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest" },
        }),
    );

    const result = await DriftService.captureBaseline({
      projectId: "p1",
      urls: ["https://example.com/page"],
    });

    expect(result.snapshots).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.error).toContain("CRAWL_TARGET_BLOCKED");
  });
});

function seedBaseline() {
  mocks.getBaseline.mockResolvedValue({
    id: "base_1",
    projectId: "p1",
    name: "Week 39",
    createdAt: "2026-09-22T00:00:00.000Z",
  });
}

function storedSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    id: "snap_1",
    baselineId: "base_1",
    url: "https://example.com/page",
    canonicalUrl: null,
    title: "Old Title",
    metaDescription: null,
    h1: "Old H1",
    schemaJsonLd: "[]",
    robotsMeta: null,
    statusCode: 200,
    indexable: true,
    wordCount: 10,
    externalLinkCount: 0,
    headersJson: "{}",
    capturedAt: "2026-09-22T01:00:00.000Z",
    ...overrides,
  };
}

describe("DriftService.compareBaseline", () => {
  it("fails when the baseline is missing or owned by another project", async () => {
    mocks.getBaseline.mockResolvedValue(null);
    await expect(
      DriftService.compareBaseline({ projectId: "p1", baselineId: "nope" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(mocks.insertChanges).not.toHaveBeenCalled();
  });

  it("inserts field diffs against the stored snapshot with severities", async () => {
    seedBaseline();
    mocks.getSnapshotsForBaseline.mockResolvedValue([storedSnapshot()]);
    mocks.getOpenChanges.mockResolvedValue([]);
    stubFetch(() =>
      pageResponse({
        title: "New Title",
        h1: "New H1",
        status: 404,
        xRobots: "noindex",
      }),
    );

    const result = await DriftService.compareBaseline({
      projectId: "p1",
      baselineId: "base_1",
    });

    expect(result).toMatchObject({
      baselineId: "base_1",
      compared: 1,
      failures: [],
      inserted: 6,
      resolved: 0,
      kept: 0,
      severityCounts: { critical: 2, warning: 2, info: 2 },
    });
    expect(mocks.insertChanges).toHaveBeenCalledWith([
      expect.objectContaining({
        field: "status_code",
        oldValue: "200",
        newValue: "404",
        severity: "critical",
      }),
      expect.objectContaining({ field: "indexable", newValue: "false" }),
      expect.objectContaining({
        field: "title",
        oldValue: "Old Title",
        newValue: "New Title",
        severity: "warning",
      }),
      expect.objectContaining({ field: "h1", severity: "warning" }),
      expect.objectContaining({ field: "word_count", severity: "info" }),
      expect.objectContaining({ field: "headers", severity: "info" }),
    ]);
    expect(mocks.resolveChanges).toHaveBeenCalledWith([], expect.any(String));
  });

  it("keeps an unchanged open row and retires a stale one", async () => {
    seedBaseline();
    mocks.getSnapshotsForBaseline.mockResolvedValue([storedSnapshot()]);
    mocks.getOpenChanges.mockResolvedValue([
      {
        id: "chg_kept",
        url: "https://example.com/page",
        field: "title",
        oldValue: "Old Title",
        newValue: "Current",
        changeType: "changed",
      },
      {
        id: "chg_stale",
        url: "https://example.com/page",
        field: "h1",
        oldValue: "Old H1",
        newValue: "Even Older H1",
        changeType: "changed",
      },
    ]);
    stubFetch(() =>
      pageResponse({ title: "Current", h1: "Brand New Heading" }),
    );

    const result = await DriftService.compareBaseline({
      projectId: "p1",
      baselineId: "base_1",
    });

    expect(result).toMatchObject({ kept: 1, resolved: 1 });
    expect(mocks.resolveChanges).toHaveBeenCalledWith(
      ["chg_stale"],
      expect.any(String),
    );
    expect(mocks.insertChanges).toHaveBeenCalledWith(
      expect.not.arrayContaining([expect.objectContaining({ field: "title" })]),
    );
  });

  it("resolves vanished drift but leaves changes for un-fetched URLs open", async () => {
    seedBaseline();
    mocks.getSnapshotsForBaseline.mockResolvedValue([
      storedSnapshot({ url: "https://example.com/stable", title: "Same" }),
      storedSnapshot({ id: "snap_2", url: "https://example.com/down" }),
    ]);
    mocks.getOpenChanges.mockResolvedValue([
      {
        id: "chg_stable",
        url: "https://example.com/stable",
        field: "title",
        oldValue: "Same",
        newValue: "Drifted",
        changeType: "changed",
      },
      {
        id: "chg_down",
        url: "https://example.com/down",
        field: "h1",
        oldValue: "Old H1",
        newValue: "New H1",
        changeType: "changed",
      },
    ]);
    stubFetch((url) => {
      if (url.includes("/down")) throw new TypeError("network down");
      return pageResponse({ title: "Same" });
    });

    const result = await DriftService.compareBaseline({
      projectId: "p1",
      baselineId: "base_1",
    });

    expect(result).toMatchObject({ compared: 1, resolved: 1 });
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.url).toBe("https://example.com/down");
    expect(result.failures[0]?.error).toContain("UPSTREAM_UNAVAILABLE");
    expect(mocks.resolveChanges).toHaveBeenCalledWith(
      ["chg_stable"],
      expect.any(String),
    );
  });
});

describe("DriftService.getHistory / getChanges", () => {
  it("normalizes the URL and clamps the history limit", async () => {
    mocks.getSnapshotsForUrl.mockResolvedValue([]);
    mocks.getChangesForUrl.mockResolvedValue([]);

    const result = await DriftService.getHistory({
      projectId: "p1",
      url: "https://EXAMPLE.com/Page#section",
      limit: 5000,
    });

    expect(result.url).toBe("https://example.com/Page");
    expect(mocks.getSnapshotsForUrl).toHaveBeenCalledWith({
      projectId: "p1",
      url: "https://example.com/Page",
      limit: 200,
    });
    expect(mocks.getChangesForUrl).toHaveBeenCalledWith({
      projectId: "p1",
      url: "https://example.com/Page",
      limit: 200,
    });
  });

  it("defaults the limit to 20 and rejects non-http URLs", async () => {
    mocks.getSnapshotsForUrl.mockResolvedValue([]);
    mocks.getChangesForUrl.mockResolvedValue([]);

    await DriftService.getHistory({ projectId: "p1", url: "https://a.com/x" });
    expect(mocks.getSnapshotsForUrl).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 20 }),
    );
    await expect(
      DriftService.getHistory({ projectId: "p1", url: "ftp://a.com/x" }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("returns baseline change history, scoped and defaulted", async () => {
    mocks.getBaseline.mockResolvedValue({
      id: "base_1",
      projectId: "p1",
      name: "Week 39",
      createdAt: "2026-09-22T00:00:00.000Z",
    });
    const rows = [{ id: "chg_1" }];
    mocks.getChangesForBaseline.mockResolvedValue(rows);

    await expect(
      DriftService.getChanges({ projectId: "p1", baselineId: "base_1" }),
    ).resolves.toEqual(rows);
    expect(mocks.getChangesForBaseline).toHaveBeenCalledWith({
      projectId: "p1",
      baselineId: "base_1",
      limit: 20,
    });

    mocks.getBaseline.mockResolvedValue(null);
    await expect(
      DriftService.getChanges({ projectId: "other", baselineId: "base_1" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
