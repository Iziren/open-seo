import { useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { AlertCircle, FileSearch, Loader2, Search } from "lucide-react";
import { auditPage, validateSchema } from "@/serverFunctions/audit";
import type { PageAuditResult } from "@/server/features/audit/services/PageAuditService";
import type { SchemaValidationResult } from "@/server/lib/audit/schema-validate";
import { getIssueDescriptor } from "@/shared/audit-issues";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import {
  HttpStatusBadge,
  LighthouseScoreBadge,
} from "@/client/features/audit/shared";

type Props = {
  projectId: string;
  initialUrl: string;
  onUrlChange: (nextUrl: string | undefined) => void;
};

function ScoreCard({
  label,
  score,
  hint,
}: {
  label: string;
  score: number | null;
  hint: string;
}) {
  return (
    <div className="card bg-base-100 border border-base-200 p-4">
      <div className="text-xs uppercase tracking-wide text-base-content/60">
        {label}
      </div>
      <div className="mt-1">
        <LighthouseScoreBadge score={score} />
        <span className="text-xs text-base-content/40"> /100</span>
      </div>
      <div className="mt-1 text-xs text-base-content/60">{hint}</div>
    </div>
  );
}

function IssueRow({
  issueType,
  details,
}: {
  issueType: string;
  details?: Record<string, unknown>;
}) {
  const descriptor = getIssueDescriptor(issueType);
  const severity = descriptor?.severity ?? "info";
  const badgeClass =
    severity === "critical"
      ? "badge-error"
      : severity === "warning"
        ? "badge-warning"
        : "badge-info";
  return (
    <li className="border-b border-base-200 py-3 last:border-0">
      <div className="flex items-center gap-2">
        <span className={`badge badge-sm ${badgeClass}`}>{severity}</span>
        <span className="font-medium text-sm">
          {descriptor?.title ?? issueType}
        </span>
      </div>
      {descriptor?.explanation && (
        <p className="mt-1 text-sm text-base-content/70">
          {descriptor.explanation}
        </p>
      )}
      {descriptor?.howToFix && (
        <p className="mt-1 text-sm text-base-content/70">
          <span className="font-medium">Fix: </span>
          {descriptor.howToFix}
        </p>
      )}
      {details && Object.keys(details).length > 0 && (
        <pre className="mt-1 text-xs text-base-content/50 overflow-x-auto">
          {JSON.stringify(details, null, 1).slice(0, 400)}
        </pre>
      )}
    </li>
  );
}

function ReportCard({
  result,
  projectId,
}: {
  result: PageAuditResult;
  projectId: string;
}) {
  const schemaLabel =
    result.schemaStatus === "valid"
      ? "Valid"
      : result.schemaStatus === "invalid"
        ? "Invalid"
        : "Missing";
  const dimensionNames = [
    "trust",
    "experience",
    "expertise",
    "authority",
    "readability",
    "originality",
    "thinness",
  ] as const;
  return (
    <div className="mt-6 space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold break-all">
          {result.title || result.finalUrl}
        </h2>
        <HttpStatusBadge code={result.statusCode} />
        {result.spaShell && (
          <span className="badge badge-warning badge-sm">
            JavaScript app shell
          </span>
        )}
        {!result.isIndexable && (
          <span className="badge badge-error badge-sm">Not indexable</span>
        )}
      </div>
      <p className="text-xs text-base-content/50 break-all">
        {result.finalUrl}
      </p>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <ScoreCard
          label="Content"
          score={result.contentScore}
          hint={`${result.wordCount} words`}
        />
        <div className="card bg-base-100 border border-base-200 p-4">
          <div className="text-xs uppercase tracking-wide text-base-content/60">
            Structured data
          </div>
          <div className="mt-1 font-medium text-sm">{schemaLabel}</div>
          <div className="mt-1 text-xs text-base-content/60">
            {result.schemaTypes.length > 0
              ? result.schemaTypes.join(", ")
              : "No JSON-LD found"}
          </div>
          {result.schemaFindings.length > 0 && (
            <ul className="mt-2 space-y-1">
              {result.schemaFindings.slice(0, 5).map((finding) => (
                <li key={finding.code} className="text-xs">
                  <span className="font-mono text-base-content/50">
                    {finding.code}
                  </span>{" "}
                  <span className="text-base-content/70">
                    {finding.message}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <ScoreCard
          label="AI citability"
          score={result.geoScore}
          hint="Quotable by AI answers"
        />
        <div className="card bg-base-100 border border-base-200 p-4">
          <div className="text-xs uppercase tracking-wide text-base-content/60">
            Issues
          </div>
          <div className="mt-1 font-medium text-sm">{result.issues.length}</div>
          <div className="mt-1 text-xs text-base-content/60">
            {result.h1Count} H1 · {result.imagesMissingAlt}/{result.imagesTotal}{" "}
            images missing alt
          </div>
        </div>
      </div>

      <div className="card bg-base-100 border border-base-200 p-4">
        <h3 className="font-semibold text-sm mb-1">
          Issues ({result.issues.length})
        </h3>
        {result.issues.length === 0 ? (
          <p className="text-sm text-base-content/60">
            No issues found on this page.
          </p>
        ) : (
          <ul>
            {result.issues.map((issue, index) => (
              <IssueRow
                key={`${issue.issueType}-${index}`}
                issueType={issue.issueType}
                details={issue.details}
              />
            ))}
          </ul>
        )}
      </div>

      {result.contentDetails && (
        <div className="card bg-base-100 border border-base-200 p-4">
          <h3 className="font-semibold text-sm mb-2">Content breakdown</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            {dimensionNames.map((name) => (
              <div
                key={name}
                className="flex items-center justify-between text-sm"
              >
                <span className="capitalize text-base-content/70">{name}</span>
                <LighthouseScoreBadge
                  score={result.contentDetails?.dimensions[name] ?? null}
                />
              </div>
            ))}
          </div>
          <div className="mt-2 text-xs text-base-content/60">
            Reading ease {Math.round(result.contentDetails.readingEase)}
            {result.contentDetails.topTerm &&
              ` · top term “${result.contentDetails.topTerm}”`}
          </div>
          {result.contentDetails.findings.length > 0 && (
            <ul className="mt-2 space-y-1">
              {result.contentDetails.findings.slice(0, 5).map((finding) => (
                <li key={finding.code} className="text-sm">
                  <span className="font-mono text-xs text-base-content/50">
                    {finding.code}
                  </span>{" "}
                  <span className="text-base-content/70">
                    {finding.message}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <ValidateSchemaCard projectId={projectId} />
    </div>
  );
}

function ValidateSchemaCard({ projectId }: { projectId: string }) {
  const [markup, setMarkup] = useState("");
  const [result, setResult] = useState<SchemaValidationResult | null>(null);
  const mutation = useMutation({
    mutationFn: (document: unknown) =>
      validateSchema({ data: { projectId, document } }),
    onSuccess: (validation) => setResult(validation),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = markup.trim();
    if (!trimmed) return;
    try {
      mutation.mutate(JSON.parse(trimmed) as unknown);
    } catch {
      setResult({
        ok: false,
        errors: [
          { code: "not-json", message: "Pasted text is not valid JSON." },
        ],
        warnings: [],
        recommendations: [],
      });
    }
  }

  return (
    <div className="card bg-base-100 border border-base-200 p-4">
      <h3 className="font-semibold text-sm">Validate JSON-LD</h3>
      <p className="mt-1 text-xs text-base-content/60">
        Paste a JSON-LD document to check it against the e-commerce rules.
      </p>
      <form onSubmit={submit} className="mt-2 space-y-2">
        <textarea
          value={markup}
          onChange={(event) => setMarkup(event.target.value)}
          placeholder='{"@context":"https://schema.org","@type":"Product",…}'
          rows={4}
          className="textarea textarea-bordered w-full font-mono text-xs"
        />
        <button
          type="submit"
          className="btn btn-sm btn-outline"
          disabled={mutation.isPending || !markup.trim()}
        >
          {mutation.isPending ? (
            <Loader2 className="size-3 animate-spin" />
          ) : null}
          Validate
        </button>
      </form>
      {mutation.isError && (
        <p className="mt-2 text-xs text-error">
          {getStandardErrorMessage(mutation.error)}
        </p>
      )}
      {result && (
        <div className="mt-2 text-sm">
          <span
            className={`badge badge-sm ${result.ok ? "badge-success" : "badge-error"}`}
          >
            {result.ok ? "Valid" : "Invalid"}
          </span>
          {[...result.errors, ...result.warnings].slice(0, 5).map((finding) => (
            <p key={finding.code} className="mt-1 text-xs">
              <span className="font-mono text-base-content/50">
                {finding.code}
              </span>{" "}
              <span className="text-base-content/70">{finding.message}</span>
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

export function PageAuditPage({ projectId, initialUrl, onUrlChange }: Props) {
  const [url, setUrl] = useState(initialUrl);
  const mutation = useMutation({
    mutationFn: (target: string) =>
      auditPage({ data: { projectId, url: target } }),
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    const target = url.trim();
    if (!target) return;
    onUrlChange(target);
    mutation.mutate(target);
  }

  return (
    <div className="max-w-4xl mx-auto p-4 md:p-6">
      <div className="flex items-center gap-2">
        <FileSearch className="size-5" />
        <h1 className="text-xl font-bold">Page Audit</h1>
      </div>
      <p className="mt-1 text-sm text-base-content/60">
        Audit a single URL on demand — content grade, structured data, and AI
        citability. Free, no credits used.
      </p>

      <form onSubmit={submit} className="mt-4 flex gap-2">
        <input
          type="url"
          required
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://example.com/products/organic-cotton-t-shirt"
          className="input input-bordered flex-1"
        />
        <button
          type="submit"
          className="btn btn-primary"
          disabled={mutation.isPending || !url.trim()}
        >
          {mutation.isPending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Search className="size-4" />
          )}
          Audit
        </button>
      </form>

      {mutation.isPending && (
        <div className="mt-6 flex items-center gap-2 text-sm text-base-content/60">
          <Loader2 className="size-4 animate-spin" />
          Fetching and analyzing the page…
        </div>
      )}

      {mutation.isError && (
        <div className="mt-6 alert alert-error">
          <AlertCircle className="size-4" />
          <span className="text-sm">
            {getStandardErrorMessage(mutation.error)}
          </span>
        </div>
      )}

      {mutation.isSuccess && (
        <ReportCard result={mutation.data} projectId={projectId} />
      )}
    </div>
  );
}
