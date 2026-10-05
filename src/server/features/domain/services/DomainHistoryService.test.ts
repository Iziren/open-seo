import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCached: vi.fn(),
  setCached: vi.fn(async () => {}),
  waitUntil: vi.fn(),
  buildCacheKey: vi.fn(
    async (prefix: string, params: Record<string, unknown>) =>
      `${prefix}:${JSON.stringify(params)}`,
  ),
}));

vi.mock("cloudflare:workers", () => ({ waitUntil: mocks.waitUntil }));

// The service never touches DataForSEO: the only network is RDAP-over-HTTPS,
// injected per call so tests run with fixture JSON and zero egress.
vi.mock("@/server/lib/r2-cache", () => ({
  buildCacheKey: mocks.buildCacheKey,
  getCached: mocks.getCached,
  setCached: mocks.setCached,
}));

import {
  DomainHistoryService,
  type AssessRiskInput,
  type LookupDomainHistoryInput,
} from "./DomainHistoryService";

const NOW_ISO = "2026-09-28T00:00:00.000Z";

const BOOTSTRAP_FIXTURE = {
  services: [[["com", "net"], ["https://rdap.verisign.com/com/v1/"]]],
};

const RDAP_DOMAIN_FIXTURE = {
  events: [
    { eventAction: "registration", eventDate: "2005-03-10T05:00:00Z" },
    { eventAction: "last changed", eventDate: "2024-02-01T00:00:00Z" },
    { eventAction: "expiration", eventDate: "2028-03-10T00:00:00Z" },
  ],
  entities: [
    {
      roles: ["registrar"],
      vcardArray: [
        "vcard",
        [
          ["version", {}, "text", "4.0"],
          ["fn", {}, "text", "Example Registrar, Inc."],
        ],
      ],
    },
  ],
};

function okJson(payload: unknown) {
  return { ok: true, json: async () => payload };
}

function rdapFetch(seenInits: Array<RequestInit | undefined> = []) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    seenInits.push(init);
    return url.includes("data.iana.org")
      ? okJson(BOOTSTRAP_FIXTURE)
      : okJson(RDAP_DOMAIN_FIXTURE);
  });
}

const input: LookupDomainHistoryInput = { domain: "Example.COM" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCached.mockResolvedValue(null);
});

describe("DomainHistoryService.lookup", () => {
  it("resolves RDAP, parses heritage, and caches the assessment", async () => {
    const seenInits: Array<RequestInit | undefined> = [];
    const fetchImpl = rdapFetch(seenInits);

    const result = await DomainHistoryService.lookup(input, {
      fetchImpl,
      nowIso: NOW_ISO,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.map((call) => call[0])).toEqual([
      "https://data.iana.org/rdap/dns.json",
      "https://rdap.verisign.com/com/v1/domain/example.com",
    ]);
    // Every RDAP hop carries the request timeout, mirroring the Python 15s/10s budgets.
    expect(seenInits[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(result).toMatchObject({
      domain: "example.com",
      whoisSource: "rdap",
      created: "2005-03-10",
      updated: "2024-02-01",
      expires: "2028-03-10",
      registrar: "Example Registrar, Inc.",
      topicalShift: null,
      risk: "unknown",
    });
    expect(result.yearsRegistered).toBeGreaterThan(21);
    expect(mocks.waitUntil).toHaveBeenCalledOnce();
  });

  it("rates an old registration with topical drift as high risk", async () => {
    const result = await DomainHistoryService.lookup(
      {
        domain: "example.com",
        currentTopic: "crypto-signals",
        baselineTopic: "veterinary",
      },
      { fetchImpl: rdapFetch(), nowIso: NOW_ISO },
    );

    expect(result.topicalShift).toBe(true);
    expect(result.risk).toBe("high");
    expect(result.notes).toContain(
      "old registration + topical drift = classic expired-domain abuse pattern",
    );
  });

  it("returns an unknown record without caching when RDAP is unreachable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("egress blocked");
    });

    const result = await DomainHistoryService.lookup(input, {
      fetchImpl,
      nowIso: NOW_ISO,
    });

    expect(result.yearsRegistered).toBeNull();
    expect(result.whoisSource).toBeNull();
    expect(result.risk).toBe("unknown");
    expect(result.notes[0]).toMatch(/RDAP lookup failed/);
    expect(mocks.waitUntil).not.toHaveBeenCalled();
    expect(mocks.setCached).not.toHaveBeenCalled();
  });

  it("serves cache hits without network calls", async () => {
    mocks.getCached.mockResolvedValue({
      domain: "example.com",
      whoisSource: "rdap",
      created: "2005-03-10",
      updated: null,
      expires: null,
      registrar: null,
      yearsRegistered: 21.55,
      notes: [],
      currentTopic: null,
      baselineTopic: null,
      topicalShift: null,
      risk: "unknown",
      anomalies: [],
    });
    const fetchImpl = rdapFetch();

    const result = await DomainHistoryService.lookup(input, {
      fetchImpl,
      nowIso: NOW_ISO,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.domain).toBe("example.com");
  });

  it("rejects invalid domains before any network call", async () => {
    const fetchImpl = rdapFetch();

    await expect(
      DomainHistoryService.lookup({ domain: "" }, { fetchImpl }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      DomainHistoryService.lookup({ domain: "not a domain!!!" }, { fetchImpl }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("DomainHistoryService.assessRisk", () => {
  it("assesses a stored record with topical signals", () => {
    const assessInput: AssessRiskInput = {
      record: {
        domain: "example.com",
        whoisSource: "rdap",
        created: "2005-03-10",
        updated: null,
        expires: null,
        registrar: null,
        yearsRegistered: 21,
        notes: [],
      },
      currentTopic: "crypto",
      baselineTopic: "veterinary",
      nowIso: NOW_ISO,
    };
    const result = DomainHistoryService.assessRisk(assessInput);

    expect(result.risk).toBe("high");
    expect(result.topicalShift).toBe(true);
  });

  it("rejects schema-invalid input without network calls", () => {
    const fetchImpl = rdapFetch();

    expect(() =>
      DomainHistoryService.assessRisk({
        record: {
          domain: "example.com",
          whoisSource: "rdap",
          created: "2005-03-10",
          updated: null,
          expires: null,
          registrar: null,
          yearsRegistered: 21,
          notes: [],
        },
        currentTopic: "",
      }),
    ).toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
