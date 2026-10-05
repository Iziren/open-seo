# Q1 Scenarios — What Triggers SEO Work in Medusa

## TL;DR (ELI5 — Explain Like I'm 5)

Think of your Medusa store like a **shop window**. OpenSEO is the **marketing consultant** who checks if people can find your shop, like what they see, and tell their friends.

**Triggers = "When should the consultant visit?"**

| Trigger                   | Real-world moment                           | What the consultant does                                                                                                                                                                                         |
| ------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **New product arrives**   | You put a new item on the shelf             | Checks the price tag (PDP page): Is the title clear? Does the description answer buyer questions? Is the photo named right? Are the structured data tags (Schema) correct so Google shows stars/price in search? |
| **Product changes**       | You update the price, description, or image | Re-checks just that item — don't re-audit the whole shop                                                                                                                                                         |
| **New collection/season** | "Summer Sale" section goes up               | Maps all the search terms people use for "summer dresses" → groups them → tells you which pages to create or update so you capture that traffic                                                                  |
| **Weekly check-up**       | Every Monday morning                        | Checks: Did we move up/down in rankings? Did any page break (404, redirect loop, lost schema)? Sends a one-page report                                                                                           |
| **Button press in admin** | You click "Check SEO" on a product          | On-demand audit, shows score + top 3 fixes right in your Medusa dashboard                                                                                                                                        |

---

## Technical Scenarios (for implementation)

### Scenario 1: Product Created / Updated → PDP Audit

**Event:** `product.created` or `product.updated`  
**Condition:** Only when `handle`, `title`, `description`, `thumbnail`, or `metadata` fields change (ignore inventory/pricing-only updates)  
**Action:** Call `run_site_audit` with `url: ${storefrontUrl}/products/${handle}`, `maxPages: 1` (single-page crawl), `runLighthouse: false`  
**Callback:** On completion, write `auditScore`, `topIssues[3]`, `schemaJsonLd` to `product.metadata.seo`  
**Why:** PDP pages are your money pages — 80% of organic revenue comes from them. A single-page audit takes ~30 seconds.

### Scenario 2: Collection/Category Created → Keyword Clustering + Hub Map

**Event:** `collection.created` or `product_category.created`  
**Condition:** When a new top-level category is added (not nested updates)  
**Action:**

1. `research_keywords` with seed = category name + parent category
2. `keyword_clustering` (future skill) on the returned set
3. Save clusters as `collection.metadata.seo_keyword_map`  
   **Why:** New silos need a content map before you write pages. Prevents "orphan pages nobody finds."

### Scenario 3: Scheduled Weekly → Rank Tracking + Drift Check

**Cron:** `0 6 * * 1` (Monday 6 AM UTC)  
**Action per project:**

1. `run_rank_tracker` for all active tracker configs
2. `get_rank_tracker` → diff positions vs last run → flag `positionDelta > 5` or `droppedOutOfTop10`
3. For flagged URLs: `run_site_audit` (single page) → compare `canonical`, `schema`, `indexable` vs last audit snapshot (`seo-drift` skill)
4. Aggregate → one Slack/email/Notification: "5 keywords dropped, 2 pages lost schema, 1 new 404"  
   **Why:** Catches regressions before traffic loss compounds. Drift is silent until it isn't.

### Scenario 4: Manual Admin Action → On-Demand Audit

**UI:** Medusa Admin → Product detail page → "SEO" tab → "Run Audit" button  
**Action:** Same as Scenario 1 but `runLighthouse: true` (full CWV) and return full issue list to admin modal  
**Response:** Show score badge (🟢 90 / 🟡 70 / 🔴 40), expandable issue list with "Fix it" links to Medusa fields (title, description, meta)  
**Why:** Content team wants proof before publishing. Zero context-switch.

### Scenario 5: Product Deleted / Archived → Cleanup

**Event:** `product.deleted` or `product.archived`  
**Action:**

- Remove from rank tracker (`remove_rank_tracking_keywords` for that product's target terms)
- Flag in OpenSEO project context as `removed: true` so future audits don't crawl 404s
- Keep historical rank data (don't delete — trend lines matter)  
  **Why:** Prevents audit noise and wasted crawl budget on dead URLs.

### Scenario 6: Bulk Import / Migration → Batch Mode

**Event:** Medusa CLI import or custom migration script  
**Action:**

1. Create OpenSEO project if missing
2. Queue all new/updated product handles → batch `run_site_audit` with `maxPages: 50` per batch (concurrency 3)
3. On complete, write `seo_audit_batch_id` to products for traceability  
   **Why:** Launch/replatform moments — you need baseline scores for 500+ PDPs fast.

---

## Event → OpenSEO Tool Mapping Table

| Medusa Event                   | OpenSEO Tool(s)                                 | Async?                        | Idempotency Key                  |
| ------------------------------ | ----------------------------------------------- | ----------------------------- | -------------------------------- |
| `product.created`              | `run_site_audit` (single)                       | Yes (poll `get_audit_status`) | `product:${id}:v${version}`      |
| `product.updated` (SEO fields) | `run_site_audit` (single)                       | Yes                           | `product:${id}:v${version}`      |
| `collection.created`           | `research_keywords` → `keyword_clustering`      | Yes                           | `collection:${id}:init`          |
| `product_category.created`     | `research_keywords` → `keyword_clustering`      | Yes                           | `category:${id}:init`            |
| Cron weekly                    | `run_rank_tracker` + `get_rank_tracker` + drift | Yes                           | `weekly:${projectId}:${ISOweek}` |
| Admin "Run Audit" click        | `run_site_audit` (single, Lighthouse)           | Yes (wait)                    | `admin:${userId}:product:${id}`  |
| `product.deleted`              | `remove_rank_tracking_keywords`                 | Yes                           | `product:${id}:cleanup`          |

---

## Idempotency & Deduplication

Every trigger produces an **idempotency key** (see table). Before enqueueing, check Redis/Medusa `job_lock` table:

```ts
const lock = await acquireLock(key, ttl: '10m')
if (!lock) return // already running
try {
  await doWork()
} finally {
  await releaseLock(key)
}
```

Prevents double-audits when Medusa fires `product.updated` twice for one save.

---

## What Medusa Reads Back (Scenario 6 consumers)

| Consumer                    | Data Path                           | Format                                   |
| --------------------------- | ----------------------------------- | ---------------------------------------- |
| Medusa Admin (product page) | `product.metadata.seo.auditScore`   | `number 0-100`                           |
| Medusa Admin (product page) | `product.metadata.seo.topIssues`    | `Array<{code, message, severity}>`       |
| Storefront PDP `<head>`     | `product.metadata.seo.schemaJsonLd` | `string` (valid JSON-LD)                 |
| Internal dashboard          | `rank_tracker.currentPositions`     | `Array<{keyword, url, position, delta}>` |
| Alerting (Slack/email)      | `driftReport.summary`               | `string` (one-line)                      |

---

## Non-Technical Summary for Stakeholders

> **"We're adding an automatic SEO quality gate to every product page."**
>
> - **When you hit Save on a product**, a background check runs in ~30 seconds.
> - **You see a score (0–100) and up to 3 specific fixes** right in the Medusa product page — no new tools to learn.
> - **Every Monday**, the system checks if any of your important keywords dropped or pages broke, and sends a one-line alert.
> - **When you add a new category**, it automatically researches what people search for and gives your content team a map of pages to write.
> - **Cost:** You bring your own DataForSEO API key (pay-as-you-go, ~$0.002 per keyword check). No monthly SEO platform fees.
> - **Rollout:** Start with Product Save → Audit (Scenario 1). Add weekly rank tracking (Scenario 3) next sprint. Content-team features (Scenario 2) when marketing asks for it.
