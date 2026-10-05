import { z } from "zod";

// Faithful port of Python domain_history.py: WHOIS heritage signals
// (creation/update/expiry dates, registrar, registration age) plus the
// expired-domain-abuse risk assessment. Field names use the repo's camelCase
// convention; the decision tree and notes keep the Python semantics.

// Exact lowercase line labels, mirroring Python's _DATE_LABELS matching.
const CREATED_LABELS = [
  "creation date",
  "created on",
  "registered on",
  "registered",
  "domain registration date",
  "registry creation date",
] as const;

const UPDATED_LABELS = [
  "updated date",
  "last updated",
  "last modified",
  "domain last updated",
  "registry updated",
] as const;

const EXPIRES_LABELS = [
  "expiration date",
  "registry expiry date",
  "expires on",
  "registrar registration expiration date",
] as const;

const REGISTRAR_LABELS = ["registrar", "registrant organization"] as const;

export const whoisSourceSchema = z.enum(["whois-binary", "fallback", "rdap"]);
export type WhoisSource = z.infer<typeof whoisSourceSchema>;

export const domainHeritageRecordSchema = z.object({
  domain: z.string(),
  whoisSource: whoisSourceSchema.nullable(),
  created: z.string().nullable(),
  updated: z.string().nullable(),
  expires: z.string().nullable(),
  registrar: z.string().nullable(),
  yearsRegistered: z.number().nullable(),
  notes: z.array(z.string()),
});
export type DomainHeritageRecord = z.infer<typeof domainHeritageRecordSchema>;

export const domainRiskSchema = z.enum(["low", "medium", "high", "unknown"]);
export type DomainRisk = z.infer<typeof domainRiskSchema>;

export const assessedDomainHistorySchema = domainHeritageRecordSchema.extend({
  currentTopic: z.string().nullable(),
  baselineTopic: z.string().nullable(),
  topicalShift: z.boolean().nullable(),
  risk: domainRiskSchema,
  anomalies: z.array(z.string()),
});
export type AssessedDomainHistory = z.infer<typeof assessedDomainHistorySchema>;

export const heritageAnomalySchema = z.enum([
  "no_creation_date",
  "young_domain",
  "recently_updated",
  "expiring_soon",
  "expired",
]);
export type HeritageAnomaly = z.infer<typeof heritageAnomalySchema>;

const MONTH_ABBR: Record<string, string> = {
  jan: "01",
  feb: "02",
  mar: "03",
  apr: "04",
  may: "05",
  jun: "06",
  jul: "07",
  aug: "08",
  sep: "09",
  oct: "10",
  nov: "11",
  dec: "12",
};

function isoDate(year: string, month: string, day: string): string | null {
  const monthNum = Number(month);
  const dayNum = Number(day);
  if (
    !Number.isInteger(monthNum) ||
    !Number.isInteger(dayNum) ||
    monthNum < 1 ||
    monthNum > 12 ||
    dayNum < 1 ||
    dayNum > 31
  ) {
    return null;
  }
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

// Port of Python _parse_date: best-effort normalization to YYYY-MM-DD.
// Explicit regexes (not Date.parse) so every supported format parses
// identically across runtimes.
export function parseWhoisDate(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  const text = value.trim();
  if (!text) return null;

  let match: RegExpMatchArray | null;
  match = text.match(/^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/);
  if (match) return isoDate(match[1], match[2], match[3]);
  match = text.match(/^(\d{4})-(\d{2})-(\d{2}) \d{2}:\d{2}:\d{2}$/);
  if (match) return isoDate(match[1], match[2], match[3]);
  match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) return isoDate(match[1], match[2], match[3]);
  match = text.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (match) {
    const month = MONTH_ABBR[match[2].toLowerCase()];
    if (!month) return null;
    return isoDate(match[3], month, match[1]);
  }
  match = text.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (match) return isoDate(match[3], match[2], match[1]);
  return null;
}

// Port of Python _extract: first "label: value" line whose label matches.
export function extractWhoisField(
  labels: readonly string[],
  text: string,
): string | null {
  const wanted = new Set(labels.map((label) => label.toLowerCase()));
  for (const line of text.split("\n")) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    if (wanted.has(line.slice(0, separator).trim().toLowerCase())) {
      const value = line.slice(separator + 1).trim();
      if (value) return value;
    }
  }
  return null;
}

export function computeYearsRegistered(
  created: string | null,
  nowIso: string = new Date().toISOString(),
): number | null {
  if (!created) return null;
  const start = Date.parse(`${created}T00:00:00Z`);
  const now = Date.parse(nowIso);
  if (Number.isNaN(start) || Number.isNaN(now)) return null;
  return Math.round(((now - start) / 86_400_000 / 365.25) * 100) / 100;
}

// Port of the parse half of Python lookup().
export function parseWhoisRecord(
  raw: string,
  domain: string,
  source: WhoisSource,
  nowIso: string = new Date().toISOString(),
): DomainHeritageRecord {
  const createdRaw = extractWhoisField(CREATED_LABELS, raw);
  const updatedRaw = extractWhoisField(UPDATED_LABELS, raw);
  const expiresRaw = extractWhoisField(EXPIRES_LABELS, raw);
  const created = createdRaw ? parseWhoisDate(createdRaw) : null;

  return {
    domain,
    whoisSource: source,
    created,
    updated: updatedRaw ? parseWhoisDate(updatedRaw) : null,
    expires: expiresRaw ? parseWhoisDate(expiresRaw) : null,
    registrar: extractWhoisField(REGISTRAR_LABELS, raw),
    yearsRegistered: computeYearsRegistered(created, nowIso),
    notes: [],
  };
}

// Port of the early-return branch of Python lookup() when no WHOIS text
// could be obtained at all.
export function unavailableHeritageRecord(
  domain: string,
  note: string,
): DomainHeritageRecord {
  return {
    domain,
    whoisSource: null,
    created: null,
    updated: null,
    expires: null,
    registrar: null,
    yearsRegistered: null,
    notes: [note],
  };
}

export function detectTopicalShift(
  currentTopic?: string | null,
  baselineTopic?: string | null,
): boolean | null {
  if (!currentTopic?.trim() || !baselineTopic?.trim()) return null;
  return (
    currentTopic.trim().toLowerCase() !== baselineTopic.trim().toLowerCase()
  );
}

const RECENT_UPDATE_WINDOW_DAYS = 90;
const EXPIRY_WARNING_WINDOW_DAYS = 90;
const MS_PER_DAY = 86_400_000;

function daysBetween(fromDateOnly: string, toDateOnly: string): number | null {
  const from = Date.parse(`${fromDateOnly}T00:00:00Z`);
  const to = Date.parse(`${toDateOnly}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return Math.round((to - from) / MS_PER_DAY);
}

// Interpretation flags over the heritage record: recency/expiry signals a
// reviewer should see alongside the risk label. Informational only — they
// never change the risk outcome, which stays a faithful port below.
export function flagHeritageAnomalies(
  record: Pick<
    DomainHeritageRecord,
    "created" | "updated" | "expires" | "yearsRegistered"
  >,
  nowIso: string = new Date().toISOString(),
): HeritageAnomaly[] {
  const flags: HeritageAnomaly[] = [];
  const today = nowIso.slice(0, 10);

  if (!record.created) flags.push("no_creation_date");
  if (record.yearsRegistered != null && record.yearsRegistered < 1) {
    flags.push("young_domain");
  }
  if (record.updated) {
    const age = daysBetween(record.updated, today);
    if (age != null && age >= 0 && age <= RECENT_UPDATE_WINDOW_DAYS) {
      flags.push("recently_updated");
    }
  }
  if (record.expires) {
    const remaining = daysBetween(today, record.expires);
    if (remaining != null) {
      if (remaining < 0) flags.push("expired");
      else if (remaining <= EXPIRY_WARNING_WINDOW_DAYS) {
        flags.push("expiring_soon");
      }
    }
  }
  return flags;
}

// Port of Python assess_risk(): WHOIS heritage plus optional topical signals
// to a high/medium/low/unknown label. The branch order and fallthroughs match
// the Python exactly — e.g. a young domain with no shift stays "unknown".
export function assessDomainRisk(
  record: DomainHeritageRecord,
  currentTopic?: string | null,
  baselineTopic?: string | null,
  nowIso: string = new Date().toISOString(),
): AssessedDomainHistory {
  const notes = [...record.notes];
  const topicalShift = detectTopicalShift(currentTopic, baselineTopic);
  const years = record.yearsRegistered;
  let risk: DomainRisk = "unknown";

  if (years == null) {
    risk = "unknown";
    notes.push("no creation date in whois response");
  } else if (years < 2 && topicalShift === true) {
    risk = "high";
    notes.push("fresh registration with declared topical shift");
  } else if (years >= 5 && topicalShift === true) {
    risk = "high";
    notes.push(
      "old registration + topical drift = classic expired-domain abuse pattern",
    );
  } else if (topicalShift === true) {
    risk = "medium";
    notes.push("topical drift detected at moderate registration age");
  } else if (years >= 1 && topicalShift === false) {
    risk = "low";
  } else if (topicalShift == null) {
    risk = "unknown";
    notes.push(
      "provide a current and baseline topic to enable shift detection",
    );
  }

  return {
    ...record,
    currentTopic: currentTopic?.trim() ? currentTopic.trim() : null,
    baselineTopic: baselineTopic?.trim() ? baselineTopic.trim() : null,
    topicalShift,
    risk,
    notes,
    anomalies: flagHeritageAnomalies(record, nowIso),
  };
}
