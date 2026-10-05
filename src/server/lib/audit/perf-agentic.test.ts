import { describe, expect, it } from "vitest";
import {
  AGENTIC_AUDIT_NOTES,
  AGENTIC_CATEGORY_ID,
  AGENTIC_PASS_MIN_SCORE,
  calculateAgenticFraction,
  classifyAgenticAudit,
  summarizeAgenticReadiness,
  type AgenticAudit,
  type AgenticAuditRef,
  type AgenticAuditStatus,
  type AgenticCheck,
  type AgenticFraction,
  type AgenticPageSignals,
  type AgenticReadiness,
} from "./perf-agentic";

const _typeChecks: {
  status: AgenticCheck["status"];
  classified: AgenticAuditStatus;
  ref: AgenticAuditRef;
  audit: AgenticAudit;
} = {
  status: "pass",
  classified: "pass",
  ref: { id: "x" },
  audit: { score: 1, scoreDisplayMode: "binary" },
};
void _typeChecks;

function audit(mode: string, score: number | null): AgenticAudit {
  return { score, scoreDisplayMode: mode };
}

function agenticLhr(): Record<string, unknown> {
  return {
    categories: {
      [AGENTIC_CATEGORY_ID]: {
        score: null,
        auditRefs: [
          { id: "agent-accessibility-tree" },
          { id: "webmcp-registered-tools" },
          { id: "llms-txt" },
          { id: "hidden-audit", group: "hidden" },
        ],
      },
    },
    audits: {
      "agent-accessibility-tree": { score: 1, scoreDisplayMode: "binary" },
      "webmcp-registered-tools": { score: 1, scoreDisplayMode: "informative" },
      "llms-txt": { score: 0, scoreDisplayMode: "binary" },
      "hidden-audit": { score: 0, scoreDisplayMode: "binary" },
    },
  };
}

describe("classifyAgenticAudit", () => {
  it("classifies modes like the report renderer", () => {
    const ref: AgenticAuditRef = { id: "x" };
    expect(classifyAgenticAudit(ref, undefined)).toBe("missing");
    expect(
      classifyAgenticAudit({ id: "x", group: "hidden" }, audit("binary", 1)),
    ).toBe("hidden");
    expect(classifyAgenticAudit(ref, audit("manual", 1))).toBe("manual");
    expect(classifyAgenticAudit(ref, audit("notApplicable", 1))).toBe(
      "not-applicable",
    );
    expect(classifyAgenticAudit(ref, audit("informative", 0))).toBe(
      "informative",
    );
    expect(classifyAgenticAudit(ref, audit("error", 1))).toBe("fail");
    expect(classifyAgenticAudit(ref, audit("binary", 0.9))).toBe("pass");
    expect(classifyAgenticAudit(ref, audit("binary", 0.89))).toBe("fail");
    expect(AGENTIC_PASS_MIN_SCORE).toBe(0.9);
  });
});

describe("calculateAgenticFraction", () => {
  it("counts passes, skips hidden and informative", () => {
    const fraction: AgenticFraction = calculateAgenticFraction(agenticLhr());
    expect(fraction).toMatchObject({
      available: true,
      passed: 1,
      counted: 2,
      informative: 1,
      display: "1/2",
    });
  });

  it("reports unavailable without the category", () => {
    expect(calculateAgenticFraction({})).toEqual({ available: false });
    expect(calculateAgenticFraction(null)).toEqual({ available: false });
  });
});

describe("summarizeAgenticReadiness", () => {
  it("combines the LHR fraction with local page signals", () => {
    const signals: AgenticPageSignals = {
      renderMode: "spa-shell",
      llmsTxt: { served: true, valid: false },
      aiCrawlersBlocked: true,
      structuredData: { hasJsonLd: false },
      semantics: { hasH1: true, htmlLang: false },
    };
    const readiness: AgenticReadiness = summarizeAgenticReadiness({
      lhr: agenticLhr(),
      signals,
    });
    expect(readiness.fraction.available).toBe(true);
    expect(
      readiness.checks.find((item) => item.id === "render-mode")?.status,
    ).toBe("fail");
    expect(
      readiness.checks.find((item) => item.id === "llms-txt")?.status,
    ).toBe("fail");
    expect(
      readiness.checks.find((item) => item.id === "robots-ai")?.status,
    ).toBe("fail");
    expect(readiness.fixes.length).toBeGreaterThan(0);
    expect(readiness.score).not.toBeNull();
    expect(AGENTIC_AUDIT_NOTES["llms-txt"]).toContain("/llms.txt");
  });

  it("passes a fully ready page and scores null with no signals", () => {
    const readiness = summarizeAgenticReadiness({
      signals: {
        renderMode: "ssr",
        llmsTxt: { served: true, valid: true },
        aiCrawlersBlocked: false,
        structuredData: { hasJsonLd: true },
        semantics: { hasH1: true, htmlLang: true },
      },
    });
    expect(readiness.score).toBe(100);
    expect(readiness.fixes).toEqual([]);
    expect(summarizeAgenticReadiness({}).score).toBeNull();
  });
});
