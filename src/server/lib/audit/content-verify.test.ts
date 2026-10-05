import { describe, expect, it } from "vitest";
import {
  contentVerifyInputSchema,
  verifyClaims,
  verifyContent,
} from "@/server/lib/audit/content-verify";
import type {
  Claim,
  ClaimKind,
  ClaimVerification,
  ContentFinding,
  ContentVerification,
  ContentVerifyInput,
} from "@/server/lib/audit/content-verify";

function codes(findings: ContentFinding[]): string[] {
  return findings.map((finding) => finding.code);
}

function firstClaim(result: ClaimVerification): Claim | null {
  return result.claims[0] ?? null;
}

function claimKinds(result: ClaimVerification): ClaimKind[] {
  return result.claims.map((claim) => claim.kind);
}

describe("verifyClaims", () => {
  it("returns empty results for text without claims", () => {
    const result = verifyClaims("We make widgets for kitchens.");
    expect(result.claims).toEqual([]);
    expect(result.claimCount).toBe(0);
    expect(result.uncitedCount).toBe(0);
    expect(result.uncitedRatio).toBe(0);
  });

  it("finds statistics, quantities, and temporal claims in order", () => {
    const result = verifyClaims(
      "47% of marketers report better results. Spend reached $3.2 billion in 2025.",
    );
    expect(result.claimCount).toBe(3);
    expect(claimKinds(result)).toEqual(["statistic", "quantity", "temporal"]);
    expect(result.uncitedCount).toBe(3);
    expect(result.uncitedRatio).toBe(1);
    const positions = result.claims.map((claim) => claim.position);
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]).toBeGreaterThanOrEqual(positions[i - 1]);
    }
  });

  it("does not double-count a percentage as statistic plus quantity", () => {
    const result = verifyClaims("47% of marketers report better results.");
    expect(result.claimCount).toBe(1);
    expect(firstClaim(result)?.kind).toBe("statistic");
    expect(firstClaim(result)?.text).toContain("47%");
  });

  it("credits a markdown link within 200 chars as a citation", () => {
    const result = verifyClaims(
      "47% of marketers report better results [Source](https://example.com/study).",
    );
    expect(result.claimCount).toBe(1);
    expect(firstClaim(result)?.hasCitation).toBe(true);
    expect(firstClaim(result)?.nearbyCitation).toContain("https://example.com");
    expect(result.uncitedCount).toBe(0);
  });

  it("credits HTML links, footnotes, and named attributions", () => {
    const html = verifyClaims(
      'Traffic rose 40% <a href="https://example.com/data">per the dataset</a>.',
    );
    const footnote = verifyClaims("We grew 3x faster [1] than competitors.");
    const attribution = verifyClaims(
      "Conversion rose 40% according to a Stanford study.",
    );
    expect(firstClaim(html)?.hasCitation).toBe(true);
    expect(firstClaim(footnote)?.kind).toBe("comparative");
    expect(firstClaim(footnote)?.hasCitation).toBe(true);
    expect(attribution.claims).toHaveLength(2);
    expect(attribution.claims.every((claim) => claim.hasCitation)).toBe(true);
  });

  it("does not credit a lowercase 'per <word>' as an attribution", () => {
    const result = verifyClaims(
      "Revenue hit $3.2 billion per the spreadsheet.",
    );
    expect(result.claimCount).toBe(1);
    expect(firstClaim(result)?.hasCitation).toBe(false);
  });

  it("extracts authority, comparative, and comma-group quantity claims", () => {
    const result = verifyClaims(
      "Gartner said conversion rose. We were twice as effective. 1,000 users joined.",
    );
    const kinds = claimKinds(result);
    expect(kinds).toContain("authority");
    expect(kinds).toContain("comparative");
    expect(kinds).toContain("quantity");
    expect(result.claimCount).toBe(3);
  });

  it("keeps the uncited ratio within 0..1", () => {
    const result = verifyClaims(
      "in 2024 we shipped. in 2025 we shipped. in 2026 we shipped.",
    );
    expect(result.claimCount).toBe(3);
    expect(result.uncitedRatio).toBeGreaterThanOrEqual(0);
    expect(result.uncitedRatio).toBeLessThanOrEqual(1);
    expect(result.uncitedRatio).toBe(1);
  });
});

describe("contentVerifyInputSchema", () => {
  it("accepts a valid input", () => {
    expect(
      contentVerifyInputSchema.safeParse({ text: "hello", title: "t" }).success,
    ).toBe(true);
  });

  it("rejects non-string and missing text", () => {
    expect(contentVerifyInputSchema.safeParse({ text: 42 }).success).toBe(
      false,
    );
    expect(contentVerifyInputSchema.safeParse({}).success).toBe(false);
  });
});

describe("verifyContent", () => {
  it("flags a meta description that restates the title", () => {
    const input: ContentVerifyInput = {
      text: "Anything at all here.",
      title: "Best Running Shoes for Marathon Training",
      metaDescription: "The best running shoes for marathon training",
    };
    const result: ContentVerification = verifyContent(input);
    expect(result.descriptionRestatesTitle).toBe(true);
    expect(result.titleDescriptionOverlap).toBe(1);
    expect(codes(result.findings)).toContain("description-restates-title");
  });

  it("accepts a description that adds new information", () => {
    const result = verifyContent({
      text: "Anything at all here.",
      title: "Best Running Shoes for Marathon Training",
      metaDescription:
        "We tested 12 pairs on wet asphalt in Portland and picked three.",
    });
    expect(result.descriptionRestatesTitle).toBe(false);
    expect(result.titleDescriptionOverlap).toBeLessThan(0.8);
  });

  it("does not flag an empty title or description", () => {
    const result = verifyContent({ text: "Body copy." });
    expect(result.descriptionRestatesTitle).toBe(false);
    expect(result.titleDescriptionOverlap).toBe(0);
  });

  it("detects lorem ipsum and TODO placeholders", () => {
    const result = verifyContent({
      text: "Lorem ipsum dolor sit amet. TODO: write the conclusion here.",
    });
    expect(result.placeholders).toContain("lorem ipsum");
    expect(result.placeholders).toContain("todo");
    expect(codes(result.findings)).toContain("placeholder-text");
  });

  it("detects un-rendered template artifacts", () => {
    const result = verifyContent({
      text: "Hello {{customer_name}}, welcome to {% store_name %}.",
    });
    expect(result.templatedArtifacts).toHaveLength(2);
    expect(codes(result.findings)).toContain("template-artifacts");
  });

  it("flags a copy block leaning on stock CTAs", () => {
    const result = verifyContent({
      text: "Learn more about the plan. Sign up now to get started today.",
    });
    expect(result.stockCtas.length).toBeGreaterThanOrEqual(2);
    expect(codes(result.findings)).toContain("stock-cta-copy");
  });

  it("reports uncited claims once three or more exist past the threshold", () => {
    const result = verifyContent({
      text: "47% of marketers report better results. Spend reached $3.2 billion. We were twice as effective.",
    });
    expect(result.claimCount).toBe(3);
    expect(result.uncitedRatio).toBe(1);
    const finding = result.findings.find(
      (candidate) => candidate.code === "uncited-claims",
    );
    expect(finding?.severity).toBe("warning");
    expect(finding?.evidence[0]).toContain("uncited ratio 1");
  });

  it("stays quiet on clean copy", () => {
    const result = verifyContent({
      text: "A plain paragraph with no claims, no placeholders, and one clear action.",
      title: "Kitchen Widgets",
      metaDescription: "Hand-made widgets for serious home cooks.",
    });
    expect(result.findings).toEqual([]);
    expect(result.claimCount).toBe(0);
  });
});
