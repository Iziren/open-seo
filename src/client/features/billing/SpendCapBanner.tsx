import { useQuery } from "@tanstack/react-query";
import { ShieldAlert } from "lucide-react";
import { getSpendPolicyState } from "@/serverFunctions/billing";

/**
 * Platform spend guardrails, visible to billing viewers: the monthly ceiling
 * the platform absorbs per organization, the per-call limit enforced
 * pre-flight, and whether the operator kill switch is engaged. Numbers only,
 * no secrets — the policy itself is operator config, not credentials.
 */
export function SpendCapBanner() {
  const policyQuery = useQuery({
    queryKey: ["spend-policy"],
    queryFn: () => getSpendPolicyState({ data: {} }),
  });

  if (policyQuery.isPending || policyQuery.isError || !policyQuery.data) {
    return null;
  }

  const policy = policyQuery.data;

  return (
    <div className="rounded-lg border border-base-300 bg-base-100 px-4 py-3 text-sm">
      <div className="flex items-center gap-2 font-medium">
        <ShieldAlert className="size-4" />
        Platform spend guardrails
      </div>
      <p className="mt-1 text-xs text-base-content/60">
        Data and AI costs are covered by the platform up to $
        {policy.monthlyCapUsd.toFixed(0)}/month per organization. Single calls
        over ${policy.perCallCapUsd.toFixed(2)} are refused before they run.
      </p>
      {policy.killSwitch && (
        <p className="mt-1 text-xs text-warning">
          Paid data calls are currently disabled by the operator — free features
          keep working.
        </p>
      )}
    </div>
  );
}
