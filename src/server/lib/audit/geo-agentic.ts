/**
 * Agentic-readiness gate: deterministic port of `agentic_check.py`. The
 * script fetches over HTTP; this module evaluates caller-supplied artifacts
 * (robots text, llms.txt, probes, catalog JSON) and never touches the
 * network. Skipped, all needing I/O or a browser: the `--ua-matrix`,
 * same-origin script fetching for WebMCP (inline static scan only),
 * `/.well-known` discovery crawling, the unknown-URL probe, the Lighthouse
 * fraction, and the accessibility-tree heuristic. `passed` is false only on
 * `fail` — warnings cost score without blocking — and `ready` is the
 * go/no-go: every P0 gate passed.
 */
import { z } from "zod";
import type { IssueSeverity } from "@/shared/audit-issues";
import { analyzeHtml } from "./page-analyzer";
import type { PageAnalysis } from "./types";
import {
  llmsVerdict,
  markdownGate,
  mk,
  parseRobots,
  robotsGate,
} from "./geo-agentic-robots";
import type { ParsedRobots } from "./geo-agentic-robots";

const probeSchema = z.object({
  status: z.number().int().nullable(),
  contentType: z.string(),
});

export const agenticInputSchema = z.object({
  url: z.string().min(1),
  html: z.string(),
  // Rendered/Googlebot body for the cloaking check (null = untested).
  renderedHtml: z.string().nullable().optional(),
  // Raw robots.txt (null = not supplied, gate reports na).
  robotsTxt: z.string().nullable().optional(),
  robotsStatus: z.number().int().nullable().optional(),
  llmsTxt: z
    .object({ status: z.number().int().nullable(), text: z.string() })
    .nullable()
    .optional(),
  // Response to `Accept: text/markdown` for the page URL.
  markdownProbe: probeSchema.extend({ vary: z.string() }).nullable().optional(),
  aiCatalog: z
    .object({
      signalled: z.boolean(),
      status: z.number().int().nullable(),
      contentType: z.string(),
      text: z.string(),
    })
    .nullable()
    .optional(),
});

export type AgenticReadinessInput = z.input<typeof agenticInputSchema>;
export type AgenticPriority = "P0" | "P1" | "P2" | "P3";
export type GateStatus = "pass" | "warn" | "fail" | "info" | "na";
export interface AgenticGate {
  code: string;
  passed: boolean;
  severity: IssueSeverity;
  priority: AgenticPriority;
  status: GateStatus;
  detail: string;
}
export interface AgenticReadyResult {
  url: string;
  score: number;
  ready: boolean;
  gates: AgenticGate[];
}

// Draft/proposal catalog types the ARD validator accepts.
const ARD_MEDIA_TYPES = new Set([
  "application/ai-catalog+json",
  "application/agent-card+json",
  "application/a2a-agent-card+json",
  "application/mcp-server-card+json",
  "application/agent-skills+zip",
  "application/agent-skills+gzip",
  'text/markdown; profile="urn:air:agent-skills"',
  "application/ai-registry",
  "application/ai-registry+json",
]);
const ARD_URN =
  /^urn:air:([a-zA-Z0-9.-]+)(?::([a-zA-Z0-9._:-]+))?:([a-zA-Z0-9._-]+)$/;
// Empty mount: the script's shell fingerprint (JS-required copy unused).
const JS_SHELL =
  /<div[^>]+id=["'](root|app|__next|__nuxt)["'][^>]*>\s*<\/div>/i;
const REGISTER_TOOL_RE = /\bregisterTool\s*\(/g;

type Parsed = z.output<typeof agenticInputSchema>;

function clampScore(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// ---- ai-catalog.json: ARD semantic checks Lighthouse runs, ported ----

function strField(item: Record<string, unknown>, key: string): string | null {
  const value = item[key];
  return typeof value === "string" ? value : null;
}

function catalogGate(
  html: string,
  robots: ParsedRobots | null,
  catalog: Parsed["aiCatalog"],
): AgenticGate {
  const linkHit = /<link\b[^>]*\brel=["'][^"']*ai-catalog/i.test(html);
  const mapHit = (robots?.agentmap.length ?? 0) > 0;
  if (!catalog && !linkHit && !mapHit)
    return mk("ard-catalog", "P3", "na", "None needed without resources.");
  if (!catalog || (catalog.status ?? 0) !== 200)
    return mk("ard-catalog", "P1", "fail", "Signalled but not loading.");
  if (catalog.contentType.toLowerCase().startsWith("text/html"))
    return mk("ard-catalog", "P1", "fail", "200 with HTML; serve 404 or JSON.");
  let data: unknown;
  try {
    data = JSON.parse(catalog.text) as unknown;
  } catch {
    return mk("ard-catalog", "P1", "fail", "Not valid JSON.");
  }
  if (!isRecord(data))
    return mk("ard-catalog", "P1", "fail", "Root must be an object.");
  const problems: string[] = [];
  if (strField(data, "specVersion") !== "1.0")
    problems.push("need specVersion 1.0");
  const entries = data["entries"];
  if (!Array.isArray(entries)) problems.push("missing entries array");
  else
    entries.forEach((entry: unknown, i: number) => {
      if (!isRecord(entry)) {
        problems.push(`entry #${i} not an object`);
        return;
      }
      const label =
        strField(entry, "displayName") ??
        strField(entry, "identifier") ??
        `#${i}`;
      const id = strField(entry, "identifier");
      if (!id) problems.push(`${label}: missing identifier`);
      else if (!ARD_URN.test(id)) problems.push(`${label}: bad URN`);
      if (!strField(entry, "displayName"))
        problems.push(`${label}: no displayName`);
      const type = strField(entry, "type");
      if (!type) problems.push(`${label}: missing type`);
      else if (!ARD_MEDIA_TYPES.has(type)) problems.push(`${label}: odd type`);
      if ("url" in entry === "data" in entry)
        problems.push(`${label}: url xor data`);
      const queries = entry["representativeQueries"];
      if (queries === undefined) problems.push(`${label}: add 2-5 queries`);
      else if (!Array.isArray(queries))
        problems.push(`${label}: queries not array`);
      else if (queries.some((q: unknown) => typeof q !== "string"))
        problems.push(`${label}: bad queries`);
      const trust = entry["trustManifest"];
      if (trust !== undefined && (!isRecord(trust) || !("identity" in trust)))
        problems.push(`${label}: trust needs identity`);
    });
  if ("collections" in data) problems.push("collections removed");
  const fatal = problems.filter((p) => !/odd type|add 2-5/.test(p));
  if (fatal.length > 0)
    return mk("ard-catalog", "P1", "fail", fatal.slice(0, 4).join("; "));
  if (problems.length > 0)
    return mk("ard-catalog", "P3", "warn", problems.slice(0, 4).join("; "));
  return mk("ard-catalog", "P3", "pass", "Catalog validates.");
}

// ---- gate assembly: one small function per script section ----

function pageGates(
  analysis: PageAnalysis,
  html: string,
  rendered: number | null,
): AgenticGate[] {
  const words = analysis.wordCount;
  const shell = JS_SHELL.test(html);
  const sServer: GateStatus =
    words < 50 && shell ? "fail" : words < 150 ? "warn" : "pass";
  const dServer = `${words} words without JS${shell ? "; app-shell" : ""}`;
  const server = mk("server-rendered", "P0", sServer, dServer);
  if (rendered === null)
    return [server, mk("no-cloaking", "P1", "na", "No rendered body.")];
  const clash = rendered < words * 0.5 && words >= 100;
  const cloaking = mk(
    "no-cloaking",
    "P1",
    clash ? "warn" : "pass",
    `raw ${words}; rendered ${rendered}`,
  );
  return [server, cloaking];
}

function webmcpGates(html: string): AgenticGate[] {
  REGISTER_TOOL_RE.lastIndex = 0;
  const calls = html.match(REGISTER_TOOL_RE)?.length ?? 0;
  const annotated = (
    html.match(/<form\b[^>]*\b(tooldescription|toolname)\s*=/gi) ?? []
  ).length;
  const forms = (html.match(/<form\b/gi) ?? []).length;
  const manifest = /<link\b[^>]*\brel=["']manifest["']/i.test(html);
  const active = calls > 0 || annotated > 0;
  const sTools: GateStatus = active ? "pass" : "info";
  const dTools = active
    ? `${calls} tools, ${annotated}/${forms} forms.`
    : "None (optional draft).";
  const tools = mk(
    "webmcp-tools",
    "P2",
    sTools,
    manifest ? `${dTools} Manifest linked.` : dTools,
  );
  const usesDoc = html.includes("document.modelContext");
  const usesNav = html.includes("navigator.modelContext");
  const sEntry: GateStatus =
    usesNav && !usesDoc ? "warn" : usesDoc ? "pass" : "na";
  const dEntry =
    usesNav && !usesDoc
      ? "Legacy entry point only."
      : usesDoc
        ? "Uses document entry."
        : "No usage.";
  const sForms: GateStatus =
    forms === 0 ? "na" : annotated === forms ? "pass" : "info";
  return [
    tools,
    mk("webmcp-entry-point", "P2", sEntry, dEntry),
    mk(
      "webmcp-form-annotations",
      "P3",
      sForms,
      `${annotated}/${forms} annotated.`,
    ),
  ];
}

function structureGates(analysis: PageAnalysis): AgenticGate[] {
  const order = analysis.headingOrder;
  const skipped = order.some((lv, i) => i > 0 && lv > order[i - 1] + 1);
  const h1 = analysis.h1s.length;
  const sHead: GateStatus =
    h1 === 0 || order.length === 0
      ? "warn"
      : h1 > 1 || skipped
        ? "info"
        : "pass";
  const dHead =
    h1 === 0 || order.length === 0
      ? "No headings for agents to navigate."
      : h1 > 1 || skipped
        ? `${h1} H1s; outline skips levels.`
        : `${h1} H1, clean outline.`;
  const schema = mk(
    "structured-data",
    "P2",
    analysis.hasStructuredData ? "pass" : "info",
    analysis.hasStructuredData
      ? "JSON-LD present."
      : "None; agents parse raw text.",
  );
  return [schema, mk("headings", "P2", sHead, dHead)];
}

// Failures block via `ready`; warnings only discount the score.
function gateCost(priority: AgenticPriority, status: GateStatus): number {
  if (status === "fail") return priority === "P0" ? 25 : 12;
  if (status === "warn") return priority === "P0" ? 12 : 6;
  return 0;
}

// Evaluate readiness from caller-supplied artifacts. Everything except url
// and html is optional: unsupplied checks report `na`, never guesses.
export function checkAgenticReadiness(
  input: AgenticReadinessInput,
): AgenticReadyResult {
  const parsed = agenticInputSchema.parse(input);
  const analysis = analyzeHtml(parsed.html, parsed.url, 200, 0);
  const robots =
    parsed.robotsTxt == null ? null : parseRobots(parsed.robotsTxt);
  const na = (code: string, priority: AgenticPriority): AgenticGate =>
    mk(code, priority, "na", "Not supplied.");
  const rendered = parsed.renderedHtml ?? null;
  const renderedAnalysis =
    rendered === null ? null : analyzeHtml(rendered, parsed.url, 200, 0);
  const gates: AgenticGate[] = [
    ...pageGates(analysis, parsed.html, renderedAnalysis?.wordCount ?? null),
    robots
      ? robotsGate(robots, parsed.robotsStatus ?? 200)
      : na("robots-txt", "P0"),
    parsed.llmsTxt
      ? llmsVerdict(parsed.llmsTxt.status, parsed.llmsTxt.text)
      : na("llms-txt", "P1"),
    markdownGate(parsed.html, parsed.markdownProbe),
    ...structureGates(analysis),
    catalogGate(parsed.html, robots, parsed.aiCatalog),
    ...webmcpGates(parsed.html),
  ];
  const total = gates.reduce(
    (sum, g) => sum + gateCost(g.priority, g.status),
    0,
  );
  const ready = gates.every((g) => g.priority !== "P0" || g.passed);
  return { url: parsed.url, score: clampScore(100 - total), ready, gates };
}
