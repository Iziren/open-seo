# OpenSEO Machine API v1 — endpoint contract

Versioned contract for server-to-server callers (Medusa module and any future
backend integration). Stability promise: **v1 paths and response fields are
additive-only** — new fields may appear, existing ones never change meaning or
disappear. Breaking changes ship as v2.

## Base + auth

- Base: `https://<worker-host>/api/v1`
- Auth: `oseo_`-prefixed API key, same keys as MCP access. Send as
  `Authorization: Bearer oseo_...` or `x-api-key: oseo_...`.
- Every project-scoped endpoint requires `projectId` (body for POST, query
  for GET). Keys reach only projects inside their organization; anything else
  is `403 forbidden`.
- Content type: `application/json` everywhere.

## Error envelope

All errors return `{ "error": "<code>", "error_description": "<detail>" }`:

| HTTP | code              | Meaning                                                                                                               |
| ---- | ----------------- | --------------------------------------------------------------------------------------------------------------------- |
| 401  | `invalid_api_key` | Missing, malformed, expired, or disabled key                                                                          |
| 403  | `forbidden`       | Project outside the key's organization                                                                                |
| 404  | `not_found`       | Audit, baseline, or project id unknown                                                                                |
| 400  | `invalid_request` | Body/query failed validation (incl. bad URL, SSRF-blocked target)                                                     |
| 409  | `conflict`        | Duplicate provisioning collision                                                                                      |
| 402  | `usage_exceeded`  | Credits depleted (`INSUFFICIENT_CREDITS`) or per-call ceiling hit (`SPEND_CAP_EXCEEDED`, detail carries the estimate) |
| 429  | `rate_limited`    | Slow down; honors `Retry-After` when present                                                                          |
| 500  | `internal_error`  | Never a caller bug; safe to retry with backoff                                                                        |

## Endpoints

### `POST /api/v1/projects/ensure`

One project per store. Idempotent: returns the existing project when the
domain already has one.

- Body: `{ "domain": "shop.example.com", "name"?: string, "locationCode"?: number, "languageCode"?: string }`
- Returns: `{ "project": { "id", "name", "domain", ... }, "created": boolean }`
- Cost: free.

### `POST /api/v1/page-audit`

Grade one URL (the PDP loop). Synchronous, typically seconds.

- Body: `{ "projectId", "url" }`
- Returns: `{ url, finalUrl, statusCode, responseTimeMs, title, metaDescription, wordCount, h1Count, imagesTotal, imagesMissingAlt, isIndexable, spaShell, contentScore (0-100|null), contentFindings[], contentDetails { dimensions, findings[], readingEase, topTerm }, schemaStatus, schemaTypes[], schemaFindings[], geoScore (0-100), issues[] }`
- Cost: free (plain fetches + CPU, no DataForSEO).
- Timeouts: 30s fetch cap; oversized bodies truncated at 1 MiB.

### `POST /api/v1/content-quality`

Content grade only. Synchronous.

- Body: `{ "projectId", "url" }`
- Returns: `{ url, finalUrl, overall (0-100), dimensions { trust, experience, expertise, authority, readability, originality, thinness }, findings[], readingEase, readingGrade, topTerm, topTermDensity, overOptimized, descriptionRestatesTitle, placeholders[], stockCtas[] }`
- Cost: free.

### `POST /api/v1/schema/generate`

Generate self-checked schema.org JSON-LD. Synchronous.

- Body: `{ "projectId", "type": "Product"|"Organization"|"Website"|"BreadcrumbList"|"FAQPage", "data": { ...type fields... } }`
  - Product: `name!`, `description?`, `image[]?`, `sku?`, `gtin?`, `mpn?`, `brand?`, `url?`, `offers? {price!, priceCurrency!, availability?, url?}`, `aggregateRating?` (**real data only — never invented**).
  - Organization: `name!`, `url?`, `logo?`, `sameAs[]?`. Website: `name!`, `url!`, `searchUrlTemplate?`. BreadcrumbList: `pageUrl!`, `siteName?`. FAQPage: `mainEntity! [{question!, answer!}]`.
- Returns: `{ "type", "document" (@graph JSON), "script" (escaped, embed-ready), "validation" { ok, errors[], warnings[] } }`
- Cost: free.

### `POST /api/v1/schema/validate`

Validate a JSON-LD document against the e-commerce rules. Synchronous.

- Body: `{ "projectId", "document": <any JSON> }`
- Returns: `{ ok, errors[] {code, message}, warnings[], recommendations[] }`
- Cost: free.

### `POST /api/v1/drift/baselines` + `GET /api/v1/drift/baselines`

Capture snapshots, or list baselines newest-first.

- POST body: `{ "projectId", "urls[1..100]", "name"? }` → `{ baseline { id, name }, snapshots[], failures[] }`. Per-URL fetch failures are reported, not fatal.
- GET query: `?projectId=` → baseline rows.
- Cost: free.

### `POST /api/v1/drift/compare`

Re-fetch a baseline and diff. Synchronous; duration scales with URL count
(sequential fetches, ~1s per URL typical).

- Body: `{ "projectId", "baselineId" }`
- Returns: `{ baselineId, compared, failures[], inserted, resolved, kept, severityCounts }`
- Cost: free. Also runs weekly per baseline server-side automatically.

### `GET /api/v1/drift/changes`

Alert-feed source.

- Query: `?projectId=&baselineId=&limit?` → change rows `{ url, field, oldValue, newValue, severity, detectedAt, resolvedAt|null }`, newest first.
- Cost: free.

### `GET /api/v1/drift/history`

Per-URL snapshots + changes.

- Query: `?projectId=&url=&limit?` → `{ url, snapshots[], changes[] }`
- Cost: free.

### `GET /api/v1/audits/results`

Full site-audit results, including the 0-100 health score.

- Query: `?projectId=&auditId=` → `{ audit { ..., healthScore|null, scoreBreakdown|null }, pages[], lighthouse[], issues[] }`
- Audits started before scoring shipped return `healthScore: null` (never a misleading zero).
- Cost: free to read (the audit itself may have spent on Lighthouse at start time).

## Caller recipes

**PDP loop (on product save):** `ensure` once per store → `page-audit` per save →
store `contentScore`, top issues, `schemaTypes` on the product → if schema
missing/invalid, `schema/generate` with the product record → inject `script`
into the PDP. On `usage_exceeded`, back off and keep the last score.

**Weekly cron:** per tracked baseline `drift/compare` → `drift/changes` (open
only) → alert on new `critical`/`high`. No scheduling state needed caller-side;
the server also auto-compares stale baselines weekly.

## Limits

- Drift baselines: 100 URLs each; comparisons sequential (no thundering herd).
- Page fetch: 30s timeout, 1 MiB body cap, SSRF policy enforced (private ranges
  and cloud metadata endpoints refused with `invalid_request`).
- Spend: platform-paid calls are pre-gated (`$2` per-call ceiling default,
  kill switch); every paid-core machine endpoint above is free by design.
- Rate limits: per-key request throttle; `429` + `Retry-After` when hit.

## Changelog

- **v1 (2026-10):** initial contract — projects/ensure, page-audit,
  content-quality, schema/generate, schema/validate, drift baselines/compare/
  changes/history, audits/results.
