interface HealthScoreBreakdownView {
  technical: number;
  content: number;
  onPage: number;
  schema: number;
  perf: number;
  ai: number;
  images: number;
  total: number;
}

const SUB_SCORES: Array<{
  key: keyof Omit<HealthScoreBreakdownView, "total">;
  label: string;
  weight: number;
}> = [
  { key: "technical", label: "Technical", weight: 22 },
  { key: "content", label: "Content", weight: 23 },
  { key: "onPage", label: "On-page", weight: 20 },
  { key: "schema", label: "Schema", weight: 10 },
  { key: "perf", label: "Performance", weight: 10 },
  { key: "ai", label: "AI readiness", weight: 10 },
  { key: "images", label: "Images", weight: 5 },
];

function bandClass(score: number): string {
  if (score >= 90) return "text-success";
  if (score >= 50) return "text-warning";
  return "text-error";
}

function bandLabel(score: number): string {
  if (score >= 90) return "Excellent";
  if (score >= 50) return "Fair";
  return "Needs work";
}

/**
 * Audit-level 0-100 health score with its weighted sub-scores. Null-safe:
 * audits completed before scoring shipped carry no score and render
 * nothing rather than a misleading zero.
 */
export function HealthScoreHeader({
  score,
  breakdown,
}: {
  score: number | null;
  breakdown: HealthScoreBreakdownView | null;
}) {
  if (score == null) return null;

  return (
    <div className="card bg-base-100 border border-base-300">
      <div className="card-body gap-3">
        <div className="flex items-center gap-4">
          <div className={`text-4xl font-bold ${bandClass(score)}`}>
            {score}
          </div>
          <div>
            <div className="font-semibold text-sm">Site health</div>
            <div className="text-xs text-base-content/60">
              {bandLabel(score)} · weighted across 7 dimensions
            </div>
          </div>
        </div>
        {breakdown && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-2">
            {SUB_SCORES.map(({ key, label, weight }) => (
              <div key={key} className="flex items-center gap-2 text-sm">
                <span className="w-28 shrink-0 text-base-content/70">
                  {label}{" "}
                  <span className="text-xs text-base-content/40">
                    {weight}%
                  </span>
                </span>
                <progress
                  className="progress progress-primary flex-1"
                  value={breakdown[key]}
                  max={100}
                />
                <span className="w-8 text-right font-medium">
                  {breakdown[key]}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
