import { describe, expect, it } from "vitest";
import {
  assessDomainRisk,
  assessedDomainHistorySchema,
  computeYearsRegistered,
  detectTopicalShift,
  domainHeritageRecordSchema,
  extractWhoisField,
  flagHeritageAnomalies,
  parseWhoisDate,
  parseWhoisRecord,
  unavailableHeritageRecord,
  type AssessedDomainHistory,
  type DomainHeritageRecord,
  type DomainRisk,
  type HeritageAnomaly,
  type WhoisSource,
} from "./domainHistoryNormalize";

const NOW_ISO = "2026-09-28T00:00:00.000Z";

const WHOIS_FIXTURE = [
  "Domain Name: EXAMPLE.COM",
  "Registrar: Example Registrar, Inc.",
  "Creation Date: 2005-03-10T05:00:00Z",
  "Updated Date: 2024-02-01",
  "Registry Expiry Date: 2026-03-10",
  "",
  "Name Server: NS1.EXAMPLE.COM",
].join("\n");

function recordFixture(
  overrides: Partial<DomainHeritageRecord> = {},
): DomainHeritageRecord {
  return {
    domain: "example.com",
    whoisSource: "rdap" as WhoisSource,
    created: "2005-03-10",
    updated: "2024-02-01",
    expires: "2026-03-10",
    registrar: "Example Registrar, Inc.",
    yearsRegistered: 21.55,
    notes: [],
    ...overrides,
  };
}

describe("parseWhoisDate", () => {
  it("normalizes every Python-supported format", () => {
    const cases: Array<[string, string]> = [
      ["2005-03-10T05:00:00Z", "2005-03-10"],
      ["2005-03-10T05:00:00.123Z", "2005-03-10"],
      ["2005-03-10 05:00:00", "2005-03-10"],
      ["2005-03-10", "2005-03-10"],
      ["10-Mar-2005", "2005-03-10"],
      ["10.03.2005", "2005-03-10"],
    ];
    for (const [raw, expected] of cases) {
      expect(parseWhoisDate(raw)).toBe(expected);
    }
  });

  it("rejects blanks, garbage, and out-of-range dates", () => {
    for (const raw of [
      null,
      undefined,
      "",
      "  ",
      "not a date",
      "10-Foo-2005",
    ]) {
      expect(parseWhoisDate(raw)).toBeNull();
    }
    expect(parseWhoisDate("2005-13-10")).toBeNull();
  });
});

describe("extractWhoisField", () => {
  it("matches labels case-insensitively on the first hit", () => {
    expect(extractWhoisField(["creation date"], WHOIS_FIXTURE)).toBe(
      "2005-03-10T05:00:00Z",
    );
    expect(
      extractWhoisField(["registrant organization"], WHOIS_FIXTURE),
    ).toBeNull();
  });
});

describe("parseWhoisRecord", () => {
  it("extracts heritage signals from WHOIS text", () => {
    const record = parseWhoisRecord(
      WHOIS_FIXTURE,
      "example.com",
      "fallback",
      NOW_ISO,
    );

    expect(record).toMatchObject({
      domain: "example.com",
      whoisSource: "fallback",
      created: "2005-03-10",
      updated: "2024-02-01",
      expires: "2026-03-10",
      registrar: "Example Registrar, Inc.",
      notes: [],
    });
    expect(record.yearsRegistered).toBeGreaterThan(21);
    expect(record.yearsRegistered).toBeLessThan(22);
  });

  it("computes exact-year registration age", () => {
    expect(computeYearsRegistered("2025-09-28", NOW_ISO)).toBe(1);
    expect(computeYearsRegistered(null, NOW_ISO)).toBeNull();
  });

  it("builds the unavailable record with guidance", () => {
    const record = unavailableHeritageRecord("example.com", "whois down");
    expect(record.yearsRegistered).toBeNull();
    expect(record.notes).toEqual(["whois down"]);
    expect(domainHeritageRecordSchema.safeParse(record).success).toBe(true);
  });
});

describe("detectTopicalShift", () => {
  it("compares trimmed case-insensitively, null when a side is missing", () => {
    expect(detectTopicalShift("Crypto", "crypto ")).toBe(false);
    expect(detectTopicalShift("crypto", "veterinary")).toBe(true);
    expect(detectTopicalShift("crypto", undefined)).toBeNull();
    expect(detectTopicalShift(undefined, undefined)).toBeNull();
  });
});

describe("assessDomainRisk", () => {
  const cases: Array<{
    name: string;
    years: number | null;
    shift: [string?, string?];
    risk: DomainRisk;
  }> = [
    { name: "no date", years: null, shift: [], risk: "unknown" },
    {
      name: "fresh registration with shift",
      years: 1.5,
      shift: ["crypto", "veterinary"],
      risk: "high",
    },
    {
      name: "old registration with drift",
      years: 21.55,
      shift: ["crypto", "veterinary"],
      risk: "high",
    },
    {
      name: "moderate age with drift",
      years: 3,
      shift: ["crypto", "veterinary"],
      risk: "medium",
    },
    {
      name: "established without shift",
      years: 3,
      shift: ["crypto", "crypto"],
      risk: "low",
    },
    {
      name: "young without shift stays unknown",
      years: 0.5,
      shift: ["crypto", "crypto"],
      risk: "unknown",
    },
    { name: "no topics stays unknown", years: 3, shift: [], risk: "unknown" },
  ];

  for (const { name, years, shift, risk } of cases) {
    it(`rates ${name} as ${risk}`, () => {
      const assessed: AssessedDomainHistory = assessDomainRisk(
        recordFixture({ yearsRegistered: years }),
        shift[0],
        shift[1],
        NOW_ISO,
      );
      expect(assessed.risk).toBe(risk);
      expect(assessedDomainHistorySchema.safeParse(assessed).success).toBe(
        true,
      );
    });
  }

  it("adds the no-date and missing-topic guidance notes", () => {
    const noDate = assessDomainRisk(
      recordFixture({ yearsRegistered: null }),
      undefined,
      undefined,
      NOW_ISO,
    );
    expect(noDate.notes).toContain("no creation date in whois response");

    const noTopics = assessDomainRisk(
      recordFixture({ yearsRegistered: 3 }),
      undefined,
      undefined,
      NOW_ISO,
    );
    expect(noTopics.notes).toContain(
      "provide a current and baseline topic to enable shift detection",
    );
  });
});

describe("flagHeritageAnomalies", () => {
  it("flags recency, expiry, youth, and missing dates", () => {
    const flags: HeritageAnomaly[] = flagHeritageAnomalies(
      {
        created: "2026-03-10",
        updated: "2026-09-01",
        expires: "2026-10-15",
        yearsRegistered: 0.55,
      },
      NOW_ISO,
    );
    expect(flags).toEqual(
      expect.arrayContaining([
        "young_domain",
        "recently_updated",
        "expiring_soon",
      ]),
    );
    expect(flags).not.toContain("expired");
  });

  it("flags expired and missing creation dates", () => {
    expect(
      flagHeritageAnomalies(
        {
          created: "2005-03-10",
          updated: "2020-01-01",
          expires: "2026-01-01",
          yearsRegistered: 21,
        },
        NOW_ISO,
      ),
    ).toContain("expired");
    expect(
      flagHeritageAnomalies(
        {
          created: null,
          updated: null,
          expires: null,
          yearsRegistered: null,
        },
        NOW_ISO,
      ),
    ).toEqual(["no_creation_date"]);
  });
});
