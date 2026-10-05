import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, History, Loader2, Plus } from "lucide-react";
import {
  captureDriftBaseline,
  compareDriftBaseline,
  getDriftChanges,
  getDriftHistory,
  listDriftBaselines,
} from "@/serverFunctions/drift";
import { getStandardErrorMessage } from "@/client/lib/error-messages";

type Props = {
  projectId: string;
  selectedBaselineId: string | undefined;
  historyUrl: string;
  onSelectionChange: (
    baselineId: string | undefined,
    url: string | undefined,
  ) => void;
};

function severityBadge(severity: string) {
  const badgeClass =
    severity === "critical" || severity === "high"
      ? "badge-error"
      : severity === "warning" || severity === "medium"
        ? "badge-warning"
        : "badge-info";
  return <span className={`badge badge-sm ${badgeClass}`}>{severity}</span>;
}

function ChangesList({
  projectId,
  baselineId,
}: {
  projectId: string;
  baselineId: string;
}) {
  const changesQuery = useQuery({
    queryKey: ["drift-changes", projectId, baselineId],
    queryFn: () =>
      getDriftChanges({ data: { projectId, baselineId, limit: 100 } }),
  });
  const queryClient = useQueryClient();
  const compareMutation = useMutation({
    mutationFn: () => compareDriftBaseline({ data: { projectId, baselineId } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["drift-changes", projectId, baselineId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["drift-baselines", projectId],
      });
    },
  });

  return (
    <div className="card bg-base-100 border border-base-200 p-4">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-sm">Changes</h3>
        <button
          className="btn btn-sm btn-outline"
          disabled={compareMutation.isPending}
          onClick={() => compareMutation.mutate()}
        >
          {compareMutation.isPending ? (
            <Loader2 className="size-3 animate-spin" />
          ) : null}
          Compare now
        </button>
      </div>
      {compareMutation.isError && (
        <p className="mt-2 text-xs text-error">
          {getStandardErrorMessage(compareMutation.error)}
        </p>
      )}
      {compareMutation.isSuccess && (
        <p className="mt-2 text-xs text-base-content/60">
          Compared {compareMutation.data.compared} page(s):{" "}
          {compareMutation.data.inserted} new, {compareMutation.data.resolved}{" "}
          resolved.
        </p>
      )}
      {changesQuery.isPending && (
        <p className="mt-2 text-sm text-base-content/60">Loading changes…</p>
      )}
      {changesQuery.isError && (
        <p className="mt-2 text-xs text-error">
          {getStandardErrorMessage(changesQuery.error)}
        </p>
      )}
      {changesQuery.data && changesQuery.data.length === 0 && (
        <p className="mt-2 text-sm text-base-content/60">
          No changes detected. Compare again after the site changes.
        </p>
      )}
      {changesQuery.data && changesQuery.data.length > 0 && (
        <ul className="mt-2 divide-y divide-base-200">
          {changesQuery.data.map((change) => (
            <li key={change.id} className="py-2">
              <div className="flex items-center gap-2 text-sm">
                {severityBadge(change.severity)}
                <span className="font-mono text-xs">{change.field}</span>
                {change.resolvedAt && (
                  <span className="badge badge-sm badge-ghost">resolved</span>
                )}
              </div>
              <p className="mt-1 text-xs break-all text-base-content/70">
                {change.url}
              </p>
              <p className="mt-1 text-xs text-base-content/60">
                <span className="line-through">{change.oldValue}</span>
                {" → "}
                <span>{change.newValue}</span>
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function DriftPage({
  projectId,
  selectedBaselineId,
  historyUrl,
  onSelectionChange,
}: Props) {
  const queryClient = useQueryClient();
  const [urlsText, setUrlsText] = useState("");
  const [name, setName] = useState("");
  const [historyInput, setHistoryInput] = useState(historyUrl);

  const baselinesQuery = useQuery({
    queryKey: ["drift-baselines", projectId],
    queryFn: () => listDriftBaselines({ data: { projectId } }),
  });
  const captureMutation = useMutation({
    mutationFn: (urls: string[]) =>
      captureDriftBaseline({
        data: { projectId, urls, name: name.trim() || undefined },
      }),
    onSuccess: (result) => {
      setUrlsText("");
      setName("");
      void queryClient.invalidateQueries({
        queryKey: ["drift-baselines", projectId],
      });
      onSelectionChange(result.baseline.id, undefined);
    },
  });
  const historyQuery = useQuery({
    queryKey: ["drift-history", projectId, historyUrl],
    queryFn: () =>
      getDriftHistory({ data: { projectId, url: historyUrl, limit: 50 } }),
    enabled: historyUrl.length > 0,
  });

  function submitCapture(event: FormEvent) {
    event.preventDefault();
    const urls = urlsText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (urls.length === 0) return;
    captureMutation.mutate(urls);
  }

  function submitHistory(event: FormEvent) {
    event.preventDefault();
    const target = historyInput.trim();
    if (!target) return;
    onSelectionChange(undefined, target);
  }

  const baselines = baselinesQuery.data ?? [];

  return (
    <div className="max-w-4xl mx-auto p-4 md:p-6">
      <div className="flex items-center gap-2">
        <History className="size-5" />
        <h1 className="text-xl font-bold">Drift Monitoring</h1>
      </div>
      <p className="mt-1 text-sm text-base-content/60">
        Snapshot pages as baselines, then compare on demand or weekly. Free, no
        credits used.
      </p>

      <div className="mt-4 card bg-base-100 border border-base-200 p-4">
        <h2 className="font-semibold text-sm">New baseline</h2>
        <form onSubmit={submitCapture} className="mt-2 space-y-2">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Name (optional, e.g. Holiday PDPs)"
            maxLength={120}
            className="input input-bordered input-sm w-full"
          />
          <textarea
            value={urlsText}
            onChange={(event) => setUrlsText(event.target.value)}
            placeholder={
              "https://example.com/products/tote\nhttps://example.com/collections/bags"
            }
            rows={4}
            className="textarea textarea-bordered w-full font-mono text-xs"
          />
          <button
            type="submit"
            className="btn btn-sm btn-primary"
            disabled={captureMutation.isPending || !urlsText.trim()}
          >
            {captureMutation.isPending ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <Plus className="size-3" />
            )}
            Capture baseline
          </button>
        </form>
        {captureMutation.isError && (
          <p className="mt-2 text-xs text-error">
            <AlertCircle className="size-3 inline mr-1" />
            {getStandardErrorMessage(captureMutation.error)}
          </p>
        )}
      </div>

      <div className="mt-4 grid md:grid-cols-2 gap-4">
        <div className="card bg-base-100 border border-base-200 p-4">
          <h2 className="font-semibold text-sm">Baselines</h2>
          {baselinesQuery.isPending && (
            <p className="mt-2 text-sm text-base-content/60">Loading…</p>
          )}
          {baselines.length === 0 && !baselinesQuery.isPending && (
            <p className="mt-2 text-sm text-base-content/60">
              No baselines yet. Capture one above.
            </p>
          )}
          <ul className="mt-2 space-y-1">
            {baselines.map((baseline) => (
              <li key={baseline.id}>
                <button
                  className={`btn btn-sm w-full justify-start ${selectedBaselineId === baseline.id ? "btn-active" : "btn-ghost"}`}
                  onClick={() => onSelectionChange(baseline.id, undefined)}
                >
                  <span className="truncate">{baseline.name}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="card bg-base-100 border border-base-200 p-4">
          <h2 className="font-semibold text-sm">Page history</h2>
          <form onSubmit={submitHistory} className="mt-2 flex gap-2">
            <input
              value={historyInput}
              onChange={(event) => setHistoryInput(event.target.value)}
              placeholder="https://example.com/…"
              className="input input-bordered input-sm flex-1"
            />
            <button type="submit" className="btn btn-sm btn-outline">
              Look up
            </button>
          </form>
          {historyQuery.data && (
            <p className="mt-2 text-xs text-base-content/60">
              {historyQuery.data.snapshots.length} snapshot(s),{" "}
              {historyQuery.data.changes.length} change(s) for this URL.
            </p>
          )}
        </div>
      </div>

      {selectedBaselineId && (
        <div className="mt-4">
          <ChangesList projectId={projectId} baselineId={selectedBaselineId} />
        </div>
      )}
    </div>
  );
}
