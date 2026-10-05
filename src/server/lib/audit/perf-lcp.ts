/**
 * LCP subpart decomposition (port of `lcp_subparts.py`).
 *
 * Turns "your LCP is 4.2s" into "TTFB is 1.1s and render delay is 2.4s, fix
 * the server response and the preload sequence". Two sources are supported:
 *
 * - Lab: a raw Lighthouse `largest-contentful-paint` audit. Newer Lighthouse
 *   exposes `details.phases`; older shapes only carry `details.items` with a
 *   phase label and timing, so both are parsed defensively.
 * - Field: CrUX `queryRecord` metrics, which since January 2025 expose the
 *   four `largest_contentful_paint_image_*` sub-metrics.
 *
 * The stored compact payload (`lighthouseStoredPayload.ts`) keeps only the
 * LCP numeric value, so callers pass the raw audit through for lab input.
 * Pure throughout; no network.
 */
export interface LabLcpAuditInput {
  numericValue?: unknown;
  details?: unknown;
}

export type LcpSubpartKey =
  | "ttfb"
  | "loadDelay"
  | "loadDuration"
  | "renderDelay";

export interface LcpSubpartSet {
  ttfbMs: number | null;
  loadDelayMs: number | null;
  loadDurationMs: number | null;
  renderDelayMs: number | null;
}

export interface LcpDominantSubpart {
  key: LcpSubpartKey;
  label: string;
  p75Ms: number;
  share: number;
}

export interface LcpBreakdown {
  overallLcpMs: number | null;
  source: "lab" | "field";
  subparts: LcpSubpartSet;
  /** Sum of the known subparts; below overall when phases overlap or are missing. */
  totalExplainedMs: number | null;
  dominant: LcpDominantSubpart[];
  recommendations: string[];
}

export const LCP_SUBPART_LABELS: Record<LcpSubpartKey, string> = {
  ttfb: "Time to first byte",
  loadDelay: "Resource load delay",
  loadDuration: "Resource load duration",
  renderDelay: "Element render delay",
};

// CrUX field metric names for the four LCP image subparts.
const CRUX_SUBPART_METRICS: Record<LcpSubpartKey, string> = {
  ttfb: "largest_contentful_paint_image_time_to_first_byte",
  loadDelay: "largest_contentful_paint_image_resource_load_delay",
  loadDuration: "largest_contentful_paint_image_resource_load_duration",
  renderDelay: "largest_contentful_paint_image_element_render_delay",
};

// Field names in document order so dominance output is deterministic.
const SUBPART_FIELDS: Array<readonly [LcpSubpartKey, keyof LcpSubpartSet]> = [
  ["ttfb", "ttfbMs"],
  ["loadDelay", "loadDelayMs"],
  ["loadDuration", "loadDurationMs"],
  ["renderDelay", "renderDelayMs"],
];

const EMPTY_SUBPARTS: LcpSubpartSet = {
  ttfbMs: null,
  loadDelayMs: null,
  loadDurationMs: null,
  renderDelayMs: null,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asMs(value: unknown): number | null {
  if (typeof value !== "number" || Number.isNaN(value) || value < 0)
    return null;
  return value;
}

function detailItems(audit: LabLcpAuditInput): Record<string, unknown>[] {
  const details: unknown = audit.details;
  const items = isRecord(details) ? details["items"] : undefined;
  const list = Array.isArray(items) ? items : isRecord(items) ? [items] : [];
  return list.filter(isRecord);
}

/** Match a phase label to a subpart key; duration checked before delay. */
function phaseKey(label: string): LcpSubpartKey | null {
  const text = label.toLowerCase().replace(/[_\s-]+/g, "");
  if (/ttfb|timetofirstbyte/.test(text)) return "ttfb";
  if (/loadduration|resourceloadduration|duration/.test(text))
    return "loadDuration";
  if (/loaddelay|resourceloaddelay/.test(text)) return "loadDelay";
  if (/renderdelay|elementrenderdelay/.test(text)) return "renderDelay";
  return null;
}

function itemTiming(item: Record<string, unknown>): number | null {
  for (const key of [
    "timingMs",
    "timing",
    "numericValue",
    "duration",
    "value",
  ]) {
    const ms = asMs(item[key]);
    if (ms != null) return ms;
  }
  return null;
}

/**
 * Read subparts from a raw Lighthouse LCP audit. Prefers `details.phases`
 * when present, otherwise scans `details.items` for phase/timing pairs.
 */
export function decomposeLabLcpAudit(audit: LabLcpAuditInput | undefined): {
  overallLcpMs: number | null;
  subparts: LcpSubpartSet;
} {
  if (!audit) {
    return { overallLcpMs: null, subparts: { ...EMPTY_SUBPARTS } };
  }
  const overallLcpMs = asMs(audit.numericValue);
  const subparts: LcpSubpartSet = { ...EMPTY_SUBPARTS };

  // details.phases is outside the compact stored shape, so read it loosely.
  const details: unknown = audit.details;
  const phases =
    isRecord(details) && isRecord(details["phases"])
      ? details["phases"]
      : undefined;
  if (phases) {
    // Accept camelCase, snake_case, and display-name variants.
    const lookup = (keys: string[]): number | null => {
      for (const key of keys) {
        const ms = asMs(phases[key]);
        if (ms != null) return ms;
      }
      return null;
    };
    subparts.ttfbMs = lookup([
      "ttfb",
      "timeToFirstByte",
      "time_to_first_byte",
      "TTFB",
    ]);
    subparts.loadDelayMs = lookup([
      "loadDelay",
      "load_delay",
      "resourceLoadDelay",
      "LoadDelay",
    ]);
    subparts.loadDurationMs = lookup([
      "loadDuration",
      "load_duration",
      "resourceLoadDuration",
      "LoadDuration",
    ]);
    subparts.renderDelayMs = lookup([
      "renderDelay",
      "render_delay",
      "elementRenderDelay",
      "RenderDelay",
    ]);
    if (Object.values(subparts).some((value) => value != null)) {
      return { overallLcpMs, subparts };
    }
  }

  for (const item of detailItems(audit)) {
    // Newer items carry an explicit phase; fall back to the stat label.
    const label = [item["phase"], item["stat"]]
      .filter((value): value is string => typeof value === "string")
      .join(" ");
    const key = phaseKey(label);
    if (!key) continue;
    const field = `${key}Ms` as keyof LcpSubpartSet;
    if (subparts[field] == null) {
      const timing = itemTiming(item);
      if (timing != null) subparts[field] = timing;
    }
  }
  return { overallLcpMs, subparts };
}

function cruxP75(metric: unknown): number | null {
  if (!isRecord(metric)) return null;
  const percentiles = metric["percentiles"];
  if (!isRecord(percentiles)) return null;
  const raw = percentiles["p75"];
  const numeric = typeof raw === "string" ? Number(raw) : raw;
  return asMs(numeric);
}

/** Read subparts from a CrUX queryRecord `metrics` map. */
export function decomposeFieldLcpSubparts(metrics: unknown): {
  overallLcpMs: number | null;
  subparts: LcpSubpartSet;
} {
  const map = isRecord(metrics) ? metrics : {};
  const subparts: LcpSubpartSet = {
    ttfbMs: cruxP75(map[CRUX_SUBPART_METRICS.ttfb]),
    loadDelayMs: cruxP75(map[CRUX_SUBPART_METRICS.loadDelay]),
    loadDurationMs: cruxP75(map[CRUX_SUBPART_METRICS.loadDuration]),
    renderDelayMs: cruxP75(map[CRUX_SUBPART_METRICS.renderDelay]),
  };
  return { overallLcpMs: cruxP75(map["largest_contentful_paint"]), subparts };
}

function recommendationFor(key: LcpSubpartKey): string {
  // Same remediation mapping as the Python port; each fires only when its
  // subpart dominates, so effort lands where the payback is.
  switch (key) {
    case "ttfb":
      return "TTFB dominates LCP. Check origin response time, server-side compute, and CDN edge cache hit rate. Aim for TTFB < 0.8s.";
    case "loadDelay":
      return "Resource load delay dominates. The LCP element is discovered late; preload the hero image with fetchpriority=high or move it ahead of blocking resources.";
    case "loadDuration":
      return "Resource load duration dominates. The LCP image is large. Serve responsive sizes (srcset), modern formats (AVIF/WebP), and compression.";
    case "renderDelay":
      return "Element render delay dominates. The element is loaded but painting is blocked. Reduce render-blocking CSS/JS above the fold.";
  }
}

/**
 * Dominant = subpart contributing >= 40% of overall LCP, the Python
 * threshold where remediation effort pays back. Without an overall value
 * shares are meaningless, so dominance needs overallLcpMs > 0.
 */
export function analyzeLcpSubparts(input: {
  overallLcpMs: number | null;
  subparts: LcpSubpartSet;
  source: "lab" | "field";
}): LcpBreakdown {
  const { overallLcpMs, subparts, source } = input;
  const known = Object.values(subparts).filter(
    (value): value is number => value != null,
  );
  const dominant: LcpDominantSubpart[] = [];
  if (overallLcpMs != null && overallLcpMs > 0) {
    for (const [subpartKey, field] of SUBPART_FIELDS) {
      const value = subparts[field];
      if (value == null) continue;
      const share = value / overallLcpMs;
      if (share >= 0.4) {
        dominant.push({
          key: subpartKey,
          label: LCP_SUBPART_LABELS[subpartKey],
          p75Ms: value,
          share: Math.round(share * 100) / 100,
        });
      }
    }
    dominant.sort((a, b) => b.share - a.share);
  }
  return {
    overallLcpMs,
    source,
    subparts,
    totalExplainedMs:
      known.length > 0 ? known.reduce((sum, value) => sum + value, 0) : null,
    dominant,
    recommendations: dominant.map((item) => recommendationFor(item.key)),
  };
}
