# OpenSEO Medusa Module — Product Requirements Document

## Executive Summary

Embed OpenSEO's SEO intelligence directly into Medusa as a native module. Merchants get automated PDP audits, keyword maps, rank tracking, and AI-citability scores without leaving Medusa Admin. You (platform) operate the OpenSEO Worker on Cloudflare; merchants bring their own DataForSEO keys and pay ~$3/mo direct.

---

## 1. Current State (What Exists in `cardinalfish`)

### OpenSEO Worker (deployed separately on Cloudflare)

| Capability         | MCP Tool                                                                                           | Server Function | Service                              | DB Tables                                                |
| ------------------ | -------------------------------------------------------------------------------------------------- | --------------- | ------------------------------------ | -------------------------------------------------------- |
| Projects / Context | `list_projects`, `create_project`, `get_project_context`, `update_project_context`                 | ✅              | `ProjectService`                     | `project`, `project_context`                             |
| Site Audit         | `run_site_audit`, `get_audit_status`, `get_audit_issues`, `get_audit_pages`                        | ✅              | `AuditService` + `SiteAuditWorkflow` | `audit`, `audit_page`, `audit_issue`                     |
| Keyword Research   | `research_keywords`, `get_keyword_metrics`, `save_keywords`, `list_saved_keywords`                 | ✅              | `KeywordsService`                    | `saved_keyword`                                          |
| Rank Tracking      | `create_rank_tracker`, `get_rank_tracker`, `run_rank_tracker`, `add/remove_rank_tracking_keywords` | ✅              | `RankTrackingService`                | `rank_tracker`, `rank_tracking_keyword`, `rank_snapshot` |
| Domain Overview    | `get_domain_overview`, `get_serp_results`                                                          | ✅              | `DomainService`                      | —                                                        |
| Backlinks          | `get_backlinks_overview`, `get_backlinks_profile`                                                  | ✅              | `BacklinksService`                   | —                                                        |
| GSC / GA4          | `get_search_console_performance`, `inspect_urls`, 9 GA4 tools                                      | ✅              | `GscService`, `Ga4Service`           | —                                                        |
| Local SEO          | `get_business_profile`, `get_local_rank_grid`, `get_business_reviews`                              | ✅              | `LocalSeoService`                    | —                                                        |
| Reports            | `save_report`, `report_templates`                                                                  | ✅              | `ReportService`                      | `report`                                                 |
| Billing / Credits  | —                                                                                                  | —               | `autumn-js`                          | `autumn_*`                                               |

### Already Hardened (Phase 1)

- `url-policy.ts`: obfuscated IPv4 canonicalization + `SEO_LOCAL_TARGETS` allowlist (tests passing)

### Medusa Integration Guide Written

- `maintainer-docs/integrate-openseo.md` — full module structure, client, subscribers, cron, admin endpoint

---

## 2. Module Scope for Medusa (MVP → v1.0)

### MVP (Sprint 1-2) — "PDP Quality Gate"

| Feature                   | OpenSEO Skill | New MCP Tool                    | New Service             | DB  | Medusa Touchpoints                                      |
| ------------------------- | ------------- | ------------------------------- | ----------------------- | --- | ------------------------------------------------------- |
| Single-page PDP audit     | `seo-page`    | `get_page_audit`                | `PageAuditService`      | —   | `product.metadata.seo` (score, topIssues, schemaJsonLd) |
| Content quality (E-E-A-T) | `seo-content` | `get_content_quality`           | `ContentQualityService` | —   | `product.metadata.seo.content`                          |
| Schema.org generation     | `seo-schema`  | `get_schema`, `generate_schema` | `SchemaService`         | —   | `product.metadata.seo.schemaJsonLd` (injected on PDP)   |

### Sprint 3 — "Content Team Enablement"

| Feature            | OpenSEO Skill       | New MCP Tool             | New Service             | DB                | Medusa Touchpoints                                    |
| ------------------ | ------------------- | ------------------------ | ----------------------- | ----------------- | ----------------------------------------------------- |
| Keyword clustering | `seo-cluster`       | `cluster_keywords`       | `KeywordClusterService` | `keyword_cluster` | `collection.metadata.seo_keyword_map`                 |
| Content briefs     | `seo-content-brief` | `generate_content_brief` | `ContentBriefService`   | `content_brief`   | Admin "Generate Brief" button → `product.description` |

### Sprint 4 — "Regression Detection"

| Feature          | OpenSEO Skill | New MCP Tool                              | New Service    | DB                   | Medusa Touchpoints               |
| ---------------- | ------------- | ----------------------------------------- | -------------- | -------------------- | -------------------------------- |
| Drift monitoring | `seo-drift`   | `capture_drift_baseline`, `compare_drift` | `DriftService` | `seo_drift_snapshot` | Weekly cron → Slack/email alerts |

### Sprint 5 — "AI Visibility"

| Feature             | OpenSEO Skill | New MCP Tool          | New Service  | DB  | Medusa Touchpoints         |
| ------------------- | ------------- | --------------------- | ------------ | --- | -------------------------- |
| GEO / AI citability | `seo-geo`     | `check_ai_citability` | `GeoService` | —   | `product.metadata.seo.geo` |

### Sprint 6+ — "Advanced"

- `seo-agentic` (Lighthouse Agentic Browsing)
- `seo-sxo` (intent mismatch)
- `seo-hreflang` (multi-region)
- `seo-competitor-pages` (vs/alternatives generator)
- `seo-ecommerce` (Merchant API, Shopping visibility)

---

## 3. Architecture: OpenSEO Worker + Medusa Module

```
┌─────────────────────────────────────────────────────────────────┐
│                        MEDUSA BACKEND                           │
│  ┌─────────────────┐    ┌─────────────────┐                    │
│  │  Product Module │    │  OpenSEO Module │                    │
│  │  (core)         │───▶│  (this PRD)     │                    │
│  └─────────────────┘    │  • Client (RPC) │                    │
│                         │  • Service      │                    │
│                         │  • Subscribers  │                    │
│                         │  • Admin API    │                    │
│                         └────────┬────────┘                    │
│                                  │ HTTP (Bearer)               │
└──────────────────────────────────┼─────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────┐
│                    OPEN SEO WORKER (Cloudflare)                 │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐             │
│  │ MCP Server  │  │ Server Fns  │  │ Audit Worker│             │
│  │ (OAuth)     │  │ (Bearer)    │  │ (DO)        │             │
│  └─────────────┘  └─────────────┘  └─────────────┘             │
│         │               │               │                        │
│         └───────────────┼───────────────┘                        │
│                         ▼                                        │
│              ┌─────────────────────┐                             │
│              │   Postgres (shared) │                             │
│              │  schema: openseo    │                             │
│              └─────────────────────┘                             │
└─────────────────────────────────────────────────────────────────┘
```

### Data Ownership

| Data                                               | Owner                      | Medusa Access     |
| -------------------------------------------------- | -------------------------- | ----------------- |
| Products, orders, customers                        | Medusa (public schema)     | Native            |
| Projects, audits, keywords, ranks, drift snapshots | OpenSEO (`openseo` schema) | Via module client |
| `product.metadata.seo`                             | Medusa (written by module) | Native            |

---

## 4. Module Specification

### 4.1 File Structure

```
medusa-backend/src/modules/openseo/
├── index.ts                    # ModuleDefinition
├── service.ts                  # OpenSeoModuleService (MedusaService)
├── client.ts                   # Typed OpenSEO Worker client
├── types.ts                    # Shared types
├── utils/
│   ├── idempotency.ts          # Redis lock helper
│   └── mapping.ts              # OpenSEO → Medusa transforms
├── events/
│   ├── product.ts              # product.created/updated/deleted
│   ├── collection.ts           # collection.created
│   └── cron.ts                 # weekly rank/drift
├── admin/
│   ├── widgets/
│   │   └── seo-score.tsx       # Admin product page widget
│   └── routes/
│       └── products/[id]/seo/  # POST /admin/products/:id/seo (on-demand audit)
└── migrations/
    └── *.sql                   # job_locks, keyword_cluster, content_brief, seo_drift_snapshot
```

### 4.2 Module Definition (`index.ts`)

```ts
import { Module } from "@medusajs/framework/utils";
import OpenSeoModuleService from "./service";

export const OPENSEO_MODULE = "openseo";

export default Module(OPENSEO_MODULE, {
  service: OpenSeoModuleService,
});
```

### 4.3 Service API (`service.ts`)

```ts
// Core methods the module exposes to Medusa
interface OpenSeoModuleService {
  // Product-level
  auditProduct(
    handle: string,
    storefrontUrl: string,
    opts?: { runLighthouse?: boolean },
  ): Promise<ProductSeoMetadata>;
  getProductSeo(handle: string): Promise<ProductSeoMetadata | null>;

  // Collection-level
  generateKeywordMap(collectionHandle: string): Promise<KeywordClusterMap>;
  generateContentBrief(
    productHandle: string,
    targetKeywords: string[],
  ): Promise<ContentBrief>;

  // Project management
  ensureProject(storeDomain: string, dataforseoKey?: string): Promise<string>;

  // Scheduled
  runWeeklyRankCheck(): Promise<DriftAlert[]>;
  runDriftCheck(urls: string[]): Promise<DriftAlert[]>;
}
```

### 4.4 Client (`client.ts`) — Minimal Surface

```ts
class OpenSeoClient {
  constructor(config: {
    workerUrl: string;
    apiKey: string;
    projectId?: string;
  });

  // Project
  ensureProject(domain: string, dataforseoKey?: string): Promise<string>;

  // Page Audit (new)
  auditPage(
    url: string,
    projectId: string,
    opts?: { runLighthouse?: boolean },
  ): Promise<PageAuditResult>;
  getPageSchema(
    url: string,
    projectId: string,
  ): Promise<{ schemaJsonLd: string }>;
  getContentQuality(
    url: string,
    projectId: string,
  ): Promise<ContentQualityResult>;

  // Keywords / Clustering
  researchKeywords(
    seed: string,
    projectId: string,
  ): Promise<KeywordResearchResult>;
  clusterKeywords(
    keywords: string[],
    projectId: string,
  ): Promise<KeywordClusterResult>;
  generateContentBrief(
    input: ContentBriefInput,
    projectId: string,
  ): Promise<ContentBriefResult>;

  // Rank Tracking
  createRankTracker(
    keywords: KeywordInput[],
    projectId: string,
  ): Promise<{ trackerId: string }>;
  runRankTracker(
    trackerId: string,
    projectId: string,
  ): Promise<{ runId: string }>;
  getRankTracker(
    trackerId: string,
    projectId: string,
  ): Promise<RankTrackerResult>;

  // Drift
  captureDriftBaseline(
    urls: string[],
    projectId: string,
  ): Promise<{ baselineId: string }>;
  compareDrift(
    baselineId: string,
    projectId: string,
  ): Promise<DriftComparisonResult>;

  // GEO
  checkAiCitability(url: string, projectId: string): Promise<GeoResult>;
}
```

---

## 5. New MCP Tools Required (Worker Side)

Each tool follows existing pattern: `src/server/mcp/tools/<name>.ts` + register in `server.ts` + add to `samChatTools.ts`.

| Tool                             | Input                                                         | Output                                                                   | Service Called          |
| -------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------- |
| `get_page_audit`                 | `{ projectId, url, runLighthouse? }`                          | `{ auditId, score, issues[], schemaJsonLd?, contentQuality? }`           | `PageAuditService`      |
| `get_content_quality`            | `{ projectId, url }`                                          | `{ eeatScore, readability, thinContent, aiPatterns, recommendations[] }` | `ContentQualityService` |
| `get_schema` / `generate_schema` | `{ projectId, url, type?: "Product"\|"Breadcrumb"\|... }`     | `{ schemaJsonLd: string }`                                               | `SchemaService`         |
| `cluster_keywords`               | `{ projectId, keywords: string[] }`                           | `{ clusters: Cluster[] }`                                                | `KeywordClusterService` |
| `generate_content_brief`         | `{ projectId, targetKeywords, productUrl?, competitorUrls? }` | `{ brief: ContentBrief }`                                                | `ContentBriefService`   |
| `capture_drift_baseline`         | `{ projectId, urls: string[] }`                               | `{ baselineId, capturedAt }`                                             | `DriftService`          |
| `compare_drift`                  | `{ projectId, baselineId }`                                   | `{ changes: DriftChange[] }`                                             | `DriftService`          |
| `check_ai_citability`            | `{ projectId, url }`                                          | `{ score, crawlerAccess, passageScores, recommendations[] }`             | `GeoService`            |

---

## 6. New Database Tables (Postgres `openseo` schema)

```sql
-- Sprint 3: Keyword clustering + content briefs
CREATE TABLE openseo.keyword_cluster (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES openseo.project(id),
  name TEXT NOT NULL,
  primary_keyword TEXT NOT NULL,
  intent TEXT,
  target_url TEXT,
  priority SMALLINT DEFAULT 0,
  keywords TEXT[] NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE openseo.content_brief (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES openseo.project(id),
  product_handle TEXT,
  target_keywords TEXT[] NOT NULL,
  competitor_urls TEXT[],
  outline JSONB NOT NULL,
  word_count_target INT,
  status TEXT DEFAULT 'draft',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Sprint 4: Drift monitoring
CREATE TABLE openseo.seo_drift_snapshot (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES openseo.project(id),
  url TEXT NOT NULL,
  canonical_url TEXT,
  title TEXT,
  meta_description TEXT,
  schema_json_ld JSONB,
  headings JSONB,
  indexable BOOLEAN,
  status_code INT,
  captured_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_drift_snapshot_project_url ON openseo.seo_drift_snapshot(project_id, url);

-- Sprint 1: Job locks (for idempotency)
CREATE TABLE openseo.job_locks (
  key TEXT PRIMARY KEY,
  expires_at TIMESTAMPTZ NOT NULL
);
```

---

## 7. Medusa Touchpoints (What Merchants See)

### 7.1 Product Admin Page — SEO Widget

```
┌─────────────────────────────────────────────────────┐
│ Product: Organic Cotton T-Shirt          [Run Audit]│
├─────────────────────────────────────────────────────┤
│ SEO Score:  87/100    🟢 Good                      │
│ ┌─────────────────────────────────────────────────┐ │
│ │ Top 3 Issues:                                   │ │
│ │ 1. ⚠️ Missing Product schema (critical)         │ │
│ │ 2. 📝 Description too thin (high)               │ │
│ │ 3. 🖼️ 3 images missing alt text (medium)        │ │
│ └─────────────────────────────────────────────────┘ │
│ [View Full Report]  [Generate Schema]  [Fix in UI]  │
└─────────────────────────────────────────────────────┘
```

- Auto-runs on `product.created/updated` (SEO fields only)
- Manual "Run Audit" button for on-demand with Lighthouse
- "Generate Schema" → writes `schemaJsonLd` to metadata
- "Fix in UI" → deep links to title/description/meta fields

### 7.2 Collection Admin — Keyword Map Tab

```
Collection: Summer Dresses
┌─────────────────────────────────────────────────────┐
│ Keyword Clusters (12 clusters, 247 keywords)        │
│ ┌─────────────┬────────────┬──────────┬────────────┐│
│ │ Cluster     │ Primary KW │ Intent   │ Target     ││
│ │ ──────────  │ ────────── │ ──────── │ ─────────  ││
│ │ Sundresses  │ sundress   │ Buy      │ /summer    ││
│ │ Maxi dresses│ maxi dress │ Compare  │ NEW PAGE   ││
│ │ Mini dresses│ mini dress │ Buy      │ NEW PAGE   ││
│ └─────────────┴────────────┴──────────┴────────────┘│
│ [Generate Briefs] [Export CSV] [Save to Project]    │
└─────────────────────────────────────────────────────┘
```

### 7.3 Admin Notifications (Weekly)

```
📉 SEO Drift Alert — 2026-01-15
• "organic cotton t-shirt" dropped from #3 → #12 (organic cotton t-shirt PDP)
• /products/linen-shirt lost Product schema (was valid 2026-01-08)
• New 404: /products/discontinued-sku-123
[View in OpenSEO] [Dismiss]
```

### 7.4 Storefront PDP Injection (Automatic)

```html
<!-- Injected by storefront middleware reading product.metadata.seo.schemaJsonLd -->
<script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "Product",
    "name": "Organic Cotton T-Shirt",
    "offers": { "@type": "Offer", "price": "29.00", "availability": "InStock" }
  }
</script>
```

---

## 8. Merchant DataForSEO Key Flow

```
Medusa Admin (Store Settings)
       │
       ▼
┌────────────────────────────────────┐
│ DataForSEO Credentials (encrypted) │
│ Login: _______________             │
│ Password: ____________             │
│ [Save]                             │
└────────────────────────────────────┘
       │
       ▼ (on project create/update)
OpenSEO Worker: create_project({ dataforseoApiKey: base64(login:pass) })
       │
       ▼
All subsequent DataForSEO calls billed to merchant's account
```

- Platform fallback key in Worker env for stores without keys
- Usage visible in Medusa Admin → Settings → SEO → "API Usage This Month"

---

## 9. Configuration

### Medusa `.env`

```env
# OpenSEO Worker (deployed separately)
OPENSEO_WORKER_URL=https://openseo-yourname.workers.dev
OPENSEO_API_KEY=sk_live_xxxxxxxxxxxx   # Service key from Worker
STOREFRONT_URL=https://your-store.com

# Optional: Redis for idempotency locks (uses Medusa PG if absent)
REDIS_URL=redis://localhost:6379
```

### Worker Secrets (Cloudflare)

```bash
wrangler secret put DATABASE_URL          # postgres://...?schema=openseo
wrangler secret put DATAFORSEO_API_KEY    # Platform fallback key
wrangler secret put OPENSEO_SERVICE_KEY   # Bearer token for Medusa module
wrangler secret put OPENROUTER_API_KEY    # For SAM agent
```

---

## 10. Rollout Plan

| Phase | Deliverable                                                                | Effort | Dependencies                 |
| ----- | -------------------------------------------------------------------------- | ------ | ---------------------------- |
| **0** | Worker deployed, Medusa module scaffold                                    | 1 day  | Cloudflare account, Postgres |
| **1** | `get_page_audit`, `get_schema`, `get_content_quality` MCP tools + services | 1 week | Phase 0                      |
| **2** | Medusa product subscriber + admin widget + storefront injection            | 1 week | Phase 1                      |
| **3** | `cluster_keywords`, `generate_content_brief` + collection UI               | 1 week | Phase 1                      |
| **4** | `capture_drift_baseline`, `compare_drift` + weekly cron + alerts           | 1 week | Phase 1                      |
| **5** | `check_ai_citability` + GEO widget                                         | 1 week | Phase 1                      |

**Total MVP: ~5 weeks** (1 dev, part-time)

---

## 11. Success Metrics

| Metric                       | Target                       |
| ---------------------------- | ---------------------------- |
| PDP audit latency (p95)      | < 45 seconds                 |
| Weekly drift alert precision | > 80% actionable             |
| Merchant DataForSEO cost     | < $5/mo typical store        |
| Schema injection coverage    | 100% of audited PDPs         |
| Module install time          | < 30 min (copy + 3 env vars) |

---

## 12. Risks & Mitigations

| Risk                                      | Likelihood | Impact | Mitigation                                    |
| ----------------------------------------- | ---------- | ------ | --------------------------------------------- |
| Cloudflare Worker cold starts add latency | Medium     | Low    | Keep-alive ping; audit is async anyway        |
| DataForSEO API changes                    | Low        | Medium | Versioned MCP tools; Worker auto-updates      |
| Merchant loses DataForSEO key             | Medium     | Low    | Platform fallback key; graceful degradation   |
| Medusa schema conflicts                   | Low        | High   | Separate `openseo` schema; no shared tables   |
| Audit worker memory spikes (Lighthouse)   | Medium     | Medium | Separate `audit-worker` DO (already isolated) |

---

## 13. Out of Scope (v1.0)

- Multi-store single OpenSEO project (1:1 mapping only)
- Human OAuth flow (service-to-service only)
- Real-time crawl streaming in admin (polling is fine)
- White-label OpenSEO UI embedding
- Competitor page generation (Sprint 6+)
- Programmatic SEO at scale (Sprint 6+)

---

## 14. Appendix: Sprint 1 Task Breakdown

### Worker Side (OpenSEO repo)

- [ ] `src/server/mcp/tools/get-page-audit.ts` — thin wrapper over `page-analyzer.ts`
- [ ] `src/server/mcp/tools/get-content-quality.ts` — port `content_quality.py` logic
- [ ] `src/server/mcp/tools/get-schema.ts` + `generate-schema.ts` — port `schema_generate.py`
- [ ] Register in `src/server/mcp/server.ts`
- [ ] Add to `src/server/features/sam/samChatTools.ts`
- [ ] `pnpm sync-plugin-skills` if shipping skills

### Medusa Side

- [ ] Copy `src/modules/openseo/` from `maintainer-docs/integrate-openseo.md`
- [ ] Add `job_locks` migration
- [ ] Wire product subscriber (`product.created/updated`)
- [ ] Build admin widget (`seo-score.tsx`)
- [ ] Build admin endpoint (`POST /admin/products/:id/seo`)
- [ ] Storefront middleware for schema injection
- [ ] Test with Medusa dev store

---

## 15. Decision Log

| Date       | Decision                          | Rationale                                           |
| ---------- | --------------------------------- | --------------------------------------------------- |
| 2026-09-28 | Separate Worker, not in-process   | Audit worker memory isolation; Cloudflare free tier |
| 2026-09-28 | Shared Postgres, `openseo` schema | One DB to manage; clear ownership                   |
| 2026-09-28 | Bearer token auth (not OAuth)     | Machine-to-machine; no human flow for MVP           |
| 2026-09-28 | 1 project per store               | Simplest tenancy; matches Medusa store model        |
| 2026-09-28 | Merchant brings DataForSEO key    | Cost attribution; no platform billing complexity    |

---

**Status:** Ready for Sprint 0 — deploy Worker, scaffold module.  
**Owner:** Platform team.  
**Reviewers:** Medusa lead, SEO lead.
