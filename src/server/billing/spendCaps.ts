import { AppError } from "@/server/lib/errors";
import { captureServerEvent } from "@/server/lib/posthog";

export interface SpendPolicy {
  /** Monthly platform spend ceiling per organization (USD). Enforced via the
   * Autumn credit allocation (ops); surfaced read-only here and in billing UI. */
  monthlyCapUsd: number;
  /** Hard pre-flight ceiling for any single paid call (USD). Enforced in code. */
  perCallCapUsd: number;
  /** Operator kill switch: when set, every paid call is refused and the
   * product degrades to free signals. */
  killSwitch: boolean;
  /** Conservative upper bound per Lighthouse URL (USD). Calibrate against
   * scripts/dataforseo-account-usage.ts; errs toward refusing. */
  lighthousePerUrlUsd: number;
  /** Conservative upper bound per keyword-research call (USD). */
  keywordResearchPerCallUsd: number;
  /** Conservative upper bound per keyword in a bulk metrics refresh (USD). */
  keywordMetricsPerKeywordUsd: number;
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function envFlag(name: string): boolean {
  const raw = (process.env[name] ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/**
 * Platform spend policy. We pay DataForSEO + OpenRouter on the customer's
 * behalf (to prove metering works), so these caps bound OUR exposure:
 * per-call refusal is enforced here in code, the monthly ceiling via the
 * Autumn credit allocation (see the billing runbook), and both are visible
 * in billing settings.
 */
export function getSpendPolicy(): SpendPolicy {
  return {
    monthlyCapUsd: envNumber("SPEND_MONTHLY_CAP_USD", 25),
    perCallCapUsd: envNumber("SPEND_PER_CALL_CAP_USD", 2),
    killSwitch: envFlag("SPEND_KILL_SWITCH"),
    lighthousePerUrlUsd: envNumber("SPEND_LIGHTHOUSE_PER_URL_USD", 0.05),
    keywordResearchPerCallUsd: envNumber(
      "SPEND_KEYWORD_RESEARCH_PER_CALL_USD",
      0.1,
    ),
    keywordMetricsPerKeywordUsd: envNumber(
      "SPEND_KEYWORD_METRICS_PER_KEYWORD_USD",
      0.01,
    ),
  };
}

export function estimateAuditLighthouseCost(lighthouseTotal: number): number {
  return lighthouseTotal * getSpendPolicy().lighthousePerUrlUsd;
}

/**
 * Pre-flight gate for paid calls. Kill switch first (refused as
 * INSUFFICIENT_CREDITS so every existing degradation path — audit launch,
 * rank checks, keyword research, MCP tools — handles it with no changes),
 * then the per-call ceiling (distinct SPEND_CAP_EXCEEDED code with the
 * estimate attached, so the denial is actionable).
 */
export function assertSpendAllowed(
  estimateUsd: number,
  context: {
    organizationId: string;
    userId: string;
    projectId?: string;
    feature: string;
  },
): void {
  const policy = getSpendPolicy();

  if (policy.killSwitch) {
    throw new AppError(
      "INSUFFICIENT_CREDITS",
      "Paid data calls are temporarily disabled by the operator. Free features keep working.",
    );
  }

  if (estimateUsd > policy.perCallCapUsd) {
    void captureServerEvent({
      distinctId: context.userId,
      event: "spend:cap_denied",
      organizationId: context.organizationId,
      properties: {
        project_id: context.projectId,
        feature: context.feature,
        estimate_usd: estimateUsd,
        per_call_cap_usd: policy.perCallCapUsd,
      },
    }).catch(() => {
      // Telemetry must never block or fail a billing gate.
    });
    throw new AppError(
      "SPEND_CAP_EXCEEDED",
      `This call would cost about $${estimateUsd.toFixed(2)}, over the $${policy.perCallCapUsd.toFixed(2)} per-call limit. Narrow the request and try again.`,
    );
  }
}
