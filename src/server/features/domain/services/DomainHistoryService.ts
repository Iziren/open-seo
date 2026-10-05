import { waitUntil } from "cloudflare:workers";
import { z } from "zod";
import { AppError } from "@/server/lib/errors";
import { buildCacheKey, getCached, setCached } from "@/server/lib/r2-cache";
import { normalizeDomainInput } from "@/server/lib/domainUtils";
import {
  assessDomainRisk,
  assessedDomainHistorySchema,
  domainHeritageRecordSchema,
  parseWhoisDate,
  parseWhoisRecord,
  unavailableHeritageRecord,
  type AssessedDomainHistory,
  type DomainHeritageRecord,
} from "@/server/features/domain/services/domainHistoryNormalize";

// The Python heritage check reads WHOIS over TCP/43 (system `whois` binary,
// socket fallback to whois.iana.org). Workers have neither child_process nor
// raw TCP, so the transport is RDAP (RFC 9082/9083) — the HTTPS successor
// serving the same registration events. All parsing and risk logic stays a
// faithful port: RDAP is converted to WHOIS-shaped text and fed through the
// same label extractor. RDAP is free, so unlike DomainService there is no
// DataForSEO spend to meter — only an R2 cache to avoid repeat lookups.

const IANA_RDAP_BOOTSTRAP_URL = "https://data.iana.org/rdap/dns.json";
const RDAP_REQUEST_TIMEOUT_MS = 15_000;
const DOMAIN_HISTORY_CACHE_TTL_SECONDS = 12 * 60 * 60;

type RdapFetch = (
  url: string,
  init?: RequestInit,
) => Promise<Pick<Response, "ok" | "json">>;

type LookupOptions = {
  fetchImpl?: RdapFetch;
  nowIso?: string;
};

const lookupDomainHistoryInputSchema = z.object({
  domain: z.string().min(1).max(253),
  currentTopic: z.string().min(1).max(120).optional(),
  baselineTopic: z.string().min(1).max(120).optional(),
});
export type LookupDomainHistoryInput = z.input<
  typeof lookupDomainHistoryInputSchema
>;

const assessRiskInputSchema = z.object({
  record: domainHeritageRecordSchema,
  currentTopic: z.string().min(1).max(120).nullable().optional(),
  baselineTopic: z.string().min(1).max(120).nullable().optional(),
  nowIso: z.string().optional(),
});
export type AssessRiskInput = z.input<typeof assessRiskInputSchema>;

const rdapBootstrapSchema = z.object({
  services: z.array(z.array(z.array(z.string()))),
});

const rdapEventSchema = z
  .object({
    eventAction: z.string().optional(),
    eventDate: z.string().optional(),
  })
  .passthrough();

const rdapDomainSchema = z
  .object({
    events: z.array(rdapEventSchema).optional(),
    entities: z
      .array(
        z
          .object({
            roles: z.array(z.string()).optional(),
            vcardArray: z.unknown().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

type RdapDates = {
  created: string | null;
  updated: string | null;
  expires: string | null;
  registrar: string | null;
};

async function fetchJson(url: string, fetchImpl: RdapFetch): Promise<unknown> {
  // Echo of the Python referral guard: only ever dial https, and only the
  // IANA bootstrap or a server it names.
  if (!url.startsWith("https://")) return null;
  let response: Pick<Response, "ok" | "json">;
  try {
    response = await fetchImpl(url, {
      signal: AbortSignal.timeout(RDAP_REQUEST_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function resolveRdapServer(bootstrap: unknown, tld: string): string | null {
  const parsed = rdapBootstrapSchema.safeParse(bootstrap);
  if (!parsed.success) return null;
  for (const entry of parsed.data.services) {
    const [tlds, urls] = entry;
    if (!tlds?.some((item) => item.toLowerCase() === tld)) continue;
    const server = urls?.find((item) => item.startsWith("https://"));
    if (server) return server.endsWith("/") ? server : `${server}/`;
  }
  return null;
}

function readRdapRegistrar(vcardArray: unknown): string | null {
  if (!Array.isArray(vcardArray) || vcardArray.length < 2) return null;
  const rows: unknown = vcardArray[1];
  if (!Array.isArray(rows)) return null;
  for (const row of rows) {
    if (
      Array.isArray(row) &&
      row[0] === "fn" &&
      typeof row[3] === "string" &&
      row[3].trim()
    ) {
      return row[3].trim();
    }
  }
  return null;
}

function rdapEventDates(
  events: Array<{ eventAction?: string; eventDate?: string }>,
): RdapDates {
  let created: string | null = null;
  let updated: string | null = null;
  let expires: string | null = null;
  for (const event of events) {
    const date = parseWhoisDate(event.eventDate);
    if (!date) continue;
    if (event.eventAction === "registration" && !created) created = date;
    else if (event.eventAction === "expiration" && !expires) expires = date;
    else if (
      (event.eventAction === "last changed" ||
        event.eventAction === "last update of RDAP database" ||
        event.eventAction === "transfer") &&
      (!updated || date > updated)
    ) {
      updated = date;
    }
  }
  return { created, updated, expires, registrar: null };
}

// One parse path: express RDAP with the WHOIS labels the extractor knows.
function rdapToWhoisText(dates: RdapDates): string {
  const lines = [
    dates.created ? `Creation Date: ${dates.created}` : null,
    dates.updated ? `Updated Date: ${dates.updated}` : null,
    dates.expires ? `Registry Expiry Date: ${dates.expires}` : null,
    dates.registrar ? `Registrar: ${dates.registrar}` : null,
  ];
  return lines.filter((line) => line != null).join("\n");
}

async function lookupWhoisText(
  domain: string,
  fetchImpl: RdapFetch,
): Promise<string | null> {
  const tld = domain.split(".").at(-1)?.toLowerCase();
  if (!tld) return null;
  const server = resolveRdapServer(
    await fetchJson(IANA_RDAP_BOOTSTRAP_URL, fetchImpl),
    tld,
  );
  if (!server) return null;
  const parsed = rdapDomainSchema.safeParse(
    await fetchJson(`${server}domain/${domain}`, fetchImpl),
  );
  if (!parsed.success) return null;

  const dates = rdapEventDates(parsed.data.events ?? []);
  const registrarEntity = (parsed.data.entities ?? []).find((entity) =>
    entity.roles?.includes("registrar"),
  );
  dates.registrar = registrarEntity
    ? readRdapRegistrar(registrarEntity.vcardArray)
    : null;
  return rdapToWhoisText(dates);
}

function parseLookupInput(raw: LookupDomainHistoryInput) {
  const parsed = lookupDomainHistoryInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError(
      "VALIDATION_ERROR",
      parsed.error.issues[0]?.message ?? "Invalid domain history input",
    );
  }
  return parsed.data;
}

async function lookup(
  input: LookupDomainHistoryInput,
  options: LookupOptions = {},
): Promise<AssessedDomainHistory> {
  const parsed = parseLookupInput(input);
  // Registrable domain: WHOIS/RDAP records live on the registered domain,
  // and this rejects fake TLDs before any network call.
  const domain = normalizeDomainInput(parsed.domain, false);
  const nowIso = options.nowIso ?? new Date().toISOString();

  const cacheKey = await buildCacheKey("domain:history", {
    domain,
    currentTopic: parsed.currentTopic ?? null,
    baselineTopic: parsed.baselineTopic ?? null,
  });
  const cached = assessedDomainHistorySchema.safeParse(
    await getCached(cacheKey),
  );
  if (cached.success) return cached.data;

  const whoisText = await lookupWhoisText(domain, options.fetchImpl ?? fetch);
  if (!whoisText) {
    // Mirrors the Python "whois unavailable" record; negative results are not
    // cached so a transient outage does not stick.
    return assessDomainRisk(
      unavailableHeritageRecord(
        domain,
        "RDAP lookup failed — check egress to data.iana.org and the authoritative RDAP server",
      ),
      parsed.currentTopic,
      parsed.baselineTopic,
      nowIso,
    );
  }

  const record = parseWhoisRecord(whoisText, domain, "rdap", nowIso);
  const assessed = assessDomainRisk(
    record,
    parsed.currentTopic,
    parsed.baselineTopic,
    nowIso,
  );
  // waitUntil, not void: workerd cancels unregistered pending I/O once the
  // response is sent, so a fire-and-forget put never persists the cache.
  waitUntil(
    setCached(cacheKey, assessed, DOMAIN_HISTORY_CACHE_TTL_SECONDS).catch(
      (error) => {
        console.error("domain.history.cache-write failed:", error);
      },
    ),
  );
  return assessed;
}

// Assess an already-fetched record with topical signals — the wiring point
// for a later MCP tool that supplies topics from content classification.
function assessRisk(input: AssessRiskInput): AssessedDomainHistory {
  const parsed = assessRiskInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new AppError(
      "VALIDATION_ERROR",
      parsed.error.issues[0]?.message ?? "Invalid domain risk input",
    );
  }
  const record: DomainHeritageRecord = parsed.data.record;
  return assessDomainRisk(
    record,
    parsed.data.currentTopic,
    parsed.data.baselineTopic,
    parsed.data.nowIso,
  );
}

export const DomainHistoryService = {
  lookup,
  assessRisk,
} as const;
