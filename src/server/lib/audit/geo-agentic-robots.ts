import type { IssueSeverity } from "@/shared/audit-issues";
import type { AgenticGate, AgenticPriority, GateStatus } from "./geo-agentic";

// token + role: training | search | user | control (robots token only).
const AI_AGENTS: ReadonlyArray<readonly [string, string]> = [
  ["GPTBot", "training"],
  ["OAI-SearchBot", "search"],
  ["ChatGPT-User", "user"],
  ["ClaudeBot", "training"],
  ["Claude-SearchBot", "search"],
  ["Claude-User", "user"],
  ["PerplexityBot", "search"],
  ["Perplexity-User", "user"],
  ["Google-Extended", "control"],
  ["CCBot", "training"],
];
const CONTENT_SIGNAL_KEYS = new Set(["search", "ai-input", "ai-train"]);

const SEVERITY: Record<AgenticPriority, IssueSeverity> = {
  P0: "critical",
  P1: "warning",
  P2: "info",
  P3: "info",
};

export function mk(
  code: string,
  priority: AgenticPriority,
  status: GateStatus,
  detail: string,
): AgenticGate {
  const gate: AgenticGate = {
    code,
    passed: status !== "fail",
    severity: SEVERITY[priority],
    priority,
    status,
    detail,
  };
  return gate;
}

// ---- robots.txt: RFC 9309 group selection, ported from the script ----

export interface RobotsRule {
  field: "allow" | "disallow";
  value: string;
}
export interface RobotsGroup {
  agents: string[];
  rules: RobotsRule[];
  contentSignal: string[];
}
export interface ParsedRobots {
  groups: RobotsGroup[];
  agentmap: string[];
}

export function parseRobots(text: string): ParsedRobots {
  const groups: RobotsGroup[] = [];
  const agentmap: string[] = [];
  let cur: RobotsGroup | null = null;
  let wasUa = false;
  const lines = text.replace(/^\uFEFF/, "").split(/\r\n|\n|\r/);
  for (const raw of lines) {
    const line = raw.split("#", 1)[0].trim();
    const colon = line.indexOf(":");
    if (!line || colon === -1) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (field === "user-agent") {
      if (!cur || !wasUa) {
        cur = { agents: [], rules: [], contentSignal: [] };
        groups.push(cur);
      }
      cur.agents.push(value);
      wasUa = true;
      continue;
    }
    wasUa = false;
    if (field === "agentmap") agentmap.push(value);
    else if (cur && (field === "allow" || field === "disallow"))
      cur.rules.push({ field, value });
    else if (cur && field === "content-signal") cur.contentSignal.push(value);
  }
  return { groups, agentmap };
}

// A named group replaces `*`; nothing inherits (RFC 9309).
function selectRules(parsed: ParsedRobots, token: string): RobotsRule[] {
  const lower = token.toLowerCase();
  const named = parsed.groups.filter((g) =>
    g.agents.some((a) => a.toLowerCase() === lower),
  );
  const star = parsed.groups.filter((g) => g.agents.includes("*"));
  return (named.length > 0 ? named : star).flatMap((g) => g.rules);
}

function patternMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const core = anchored ? pattern.slice(0, -1) : pattern;
  const esc = core
    .split("*")
    .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${esc.join(".*")}${anchored ? "$" : ""}`).test(path);
}

// Longest-match wins; allow wins ties; empty disallow allows all.
function isAllowed(rules: RobotsRule[]): boolean {
  let best = -1;
  let allowed = true;
  for (const rule of rules) {
    if (rule.field === "disallow" && rule.value === "") continue;
    if (patternMatches(rule.value, "/") && rule.value.length >= best) {
      best = rule.value.length;
      allowed = rule.field === "allow";
    }
  }
  return allowed;
}

// `search=yes, ai-input=yes, ai-train=no` → offending parts, if any.
function signalIssues(value: string): string[] {
  const issues: string[] = [];
  for (const part of value.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    const key = trimmed
      .slice(0, eq === -1 ? trimmed.length : eq)
      .trim()
      .toLowerCase();
    const val =
      eq === -1
        ? ""
        : trimmed
            .slice(eq + 1)
            .trim()
            .toLowerCase();
    const bad =
      !CONTENT_SIGNAL_KEYS.has(key) || (val !== "yes" && val !== "no");
    if (bad) issues.push(`bad part '${trimmed}'`);
  }
  return issues;
}

// ---- llms.txt: Lighthouse 13.5.0 `llms-txt` rules, ported ----

export function llmsVerdict(status: number | null, text: string): AgenticGate {
  if (status === null || status >= 500)
    return mk("llms-txt", "P1", "fail", "Fetch failed.");
  if (status >= 400)
    return mk("llms-txt", "P1", "info", `Absent (${status}); optional.`);
  if (/^<!doctype html|^<html/i.test(text.trim()))
    return mk("llms-txt", "P1", "fail", "200 with HTML; serve 404 or a file.");
  const errors: string[] = [];
  const body = text.replace(/^\uFEFF/, "");
  if (!/^[\s]*#\s+.+/m.test(body)) errors.push("missing H1");
  if (!/\[.+\]\(.+\)/.test(body)) errors.push("no Markdown links");
  if (body.length < 50) errors.push("under 50 characters");
  if (errors.length > 0)
    return mk("llms-txt", "P1", "fail", `Invalid: ${errors.join("; ")}`);
  return mk("llms-txt", "P1", "pass", "H1, links, length present.");
}

export function robotsGate(robots: ParsedRobots, status: number): AgenticGate {
  const verdict = (token: string): boolean =>
    isAllowed(selectRules(robots, token));
  const search = AI_AGENTS.filter((a) => a[1] === "search");
  const blocked = search.filter((a) => !verdict(a[0]));
  const tokens = search.map((a) => a[0]).join(", ");
  const signals = robots.groups.flatMap((g) => g.contentSignal);
  const issues = signals.flatMap(signalIssues);
  const sReach: GateStatus =
    status >= 500 ? "fail" : status >= 400 ? "warn" : "pass";
  const sGroups: GateStatus =
    blocked.length > 0 || issues.length > 0 ? "warn" : "pass";
  const sSignal =
    signals.length === 0
      ? `signal absent (optional)`
      : issues.length > 0
        ? `signal: ${issues[0]}`
        : "signal ok";
  const dGroups =
    blocked.length > 0
      ? `blocked: ${blocked.map((a) => a[0]).join(", ")}`
      : `allowed: ${tokens}; ${sSignal}`;
  const detail =
    sReach === "pass" ? dGroups : `HTTP ${status}; ${dGroups.toLowerCase()}`;
  const statusRank =
    sReach === "fail"
      ? "fail"
      : sReach === "warn" || sGroups === "warn"
        ? "warn"
        : "pass";
  return mk("robots-txt", "P0", statusRank, detail);
}

export interface MarkdownProbe {
  status: number | null;
  contentType: string;
  vary: string;
}

export function markdownGate(
  html: string,
  probe: MarkdownProbe | null | undefined,
): AgenticGate {
  const relAlt = /<link\b[^>]*\brel=["'][^"']*alternate/i.test(html);
  const mdType = /type=["']text\/markdown/i.test(html);
  if (!probe)
    return mk(
      "markdown-delivery",
      "P1",
      relAlt && mdType ? "pass" : "info",
      relAlt && mdType ? "Alternate linked." : "Optional; none found.",
    );
  const negotiated =
    probe.status === 200 &&
    probe.contentType.toLowerCase().includes("text/markdown");
  if (!negotiated && !(relAlt && mdType))
    return mk("markdown-delivery", "P1", "info", "Optional; none found.");
  if (negotiated && !/accept/i.test(probe.vary))
    return mk(
      "markdown-delivery",
      "P1",
      "warn",
      "No Vary: Accept; caches may misserve.",
    );
  return mk("markdown-delivery", "P1", "pass", "Markdown available.");
}
