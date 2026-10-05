import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  env: {},
  DurableObject: class {
    kind = "mock";
  },
}));

import {
  assertSpendAllowed,
  estimateAuditLighthouseCost,
  getSpendPolicy,
  type SpendPolicy,
} from "./spendCaps";

const ENV_KEYS = [
  "SPEND_MONTHLY_CAP_USD",
  "SPEND_PER_CALL_CAP_USD",
  "SPEND_KILL_SWITCH",
  "SPEND_LIGHTHOUSE_PER_URL_USD",
  "SPEND_KEYWORD_RESEARCH_PER_CALL_USD",
  "SPEND_KEYWORD_METRICS_PER_KEYWORD_USD",
];

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  vi.unstubAllEnvs();
});

describe("getSpendPolicy", () => {
  it("defaults to the platform-paid guardrails", () => {
    const policy: SpendPolicy = getSpendPolicy();
    expect(policy).toMatchObject({
      monthlyCapUsd: 25,
      perCallCapUsd: 2,
      killSwitch: false,
    });
  });

  it("honours env overrides and ignores garbage", () => {
    vi.stubEnv("SPEND_MONTHLY_CAP_USD", "50");
    vi.stubEnv("SPEND_PER_CALL_CAP_USD", "5");
    vi.stubEnv("SPEND_KILL_SWITCH", "1");
    expect(getSpendPolicy()).toMatchObject({
      monthlyCapUsd: 50,
      perCallCapUsd: 5,
      killSwitch: true,
    });

    vi.stubEnv("SPEND_PER_CALL_CAP_USD", "nonsense");
    expect(getSpendPolicy().perCallCapUsd).toBe(2);
  });
});

describe("estimateAuditLighthouseCost", () => {
  it("scales linearly with the lighthouse sample", () => {
    const policy = getSpendPolicy();
    expect(estimateAuditLighthouseCost(20)).toBe(
      20 * policy.lighthousePerUrlUsd,
    );
    expect(estimateAuditLighthouseCost(0)).toBe(0);
  });
});

describe("assertSpendAllowed", () => {
  const context = {
    organizationId: "org_1",
    userId: "user_1",
    projectId: "project_1",
    feature: "test",
  };

  it("passes estimates under the per-call ceiling", () => {
    expect(() => assertSpendAllowed(1.99, context)).not.toThrow();
    expect(() => assertSpendAllowed(2, context)).not.toThrow();
  });

  it("refuses estimates over the ceiling with an actionable code", () => {
    try {
      assertSpendAllowed(2.01, context);
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: "SPEND_CAP_EXCEEDED" });
    }
  });

  it("refuses everything through the existing credits path when killed", () => {
    vi.stubEnv("SPEND_KILL_SWITCH", "true");
    try {
      assertSpendAllowed(0, context);
      expect.unreachable();
    } catch (error) {
      // Deliberately INSUFFICIENT_CREDITS: every degradation path already
      // handles it, so the kill switch degrades instead of erroring new UI.
      expect(error).toMatchObject({ code: "INSUFFICIENT_CREDITS" });
    }
  });
});
