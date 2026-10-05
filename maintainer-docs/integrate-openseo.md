# Integrate OpenSEO into Medusa Backend

## Architecture Decision (from grill)

| Decision                | Choice                                                     | Rationale                                                                       |
| ----------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------- |
| **Integration surface** | TanStack Server Functions (RPC)                            | Native TS, Zod schemas, auth/billing built in, no protocol overhead             |
| **Deployment**          | OpenSEO Worker on Cloudflare (separate)                    | Free tier, D1 free, audit worker memory isolation, no Playwright on Medusa host |
| **Database**            | Shared Postgres, `openseo` schema                          | One Postgres instance, clear ownership, no sync lag                             |
| **Auth**                | Machine-to-machine API key (service-to-service)            | Simple, no human OAuth flow needed for MVP                                      |
| **Tenancy**             | 1 OpenSEO project per Medusa store                         | Simplest mapping                                                                |
| **DataForSEO key**      | Merchant enters in Medusa admin → passed at project create | Costs attributable per store                                                    |

---

## 1. Deploy OpenSEO Worker (one-time)

### Prerequisites

- Cloudflare account (free tier works)
- Postgres database (same as Medusa or separate)
- DataForSEO account (for API key)

### Steps

```bash
# In cardinalfish repo (this repo)
git clone https://github.com/PrecisionHQ/open-seo.git open-seo-worker
cd open-seo-worker

# Configure for Postgres (not D1) — edit wrangler.jsonc:
# - Remove D1 bindings
# - Add DATABASE_URL secret (postgres://...)
# - Keep KV for OAuth if you want external MCP clients

# Set secrets via Cloudflare dashboard or wrangler:
wrangler secret put DATAFORSEO_API_KEY       # base64(login:password) — platform fallback key
wrangler secret put DATABASE_URL             # postgres://user:pass@host:5432/medusa?schema=openseo
wrangler secret put OPENROUTER_API_KEY       # for SAM agent (optional)
wrangler secret put AUTUMN_PUBLISHABLE_KEY   # if using autumn-js billing
wrangler secret put AUTUMN_SECRET_KEY

# Deploy
pnpm install --frozen-lockfile
pnpm run db:generate:pg
pnpm run db:migrate:pg
pnpm run deploy:postgres   # builds + deploys to Cloudflare
```

**Result:** Worker at `https://openseo-yourname.workers.dev` with:

- MCP server at `/mcp` (OAuth-protected)
- Server functions at `/api/*` (Bearer token auth)
- Audit worker at separate route (auto-deployed via `wrangler.audit.jsonc`)

---

## 2. Create Medusa Module: `openseo`

### File Structure

```
medusa-backend/
├── src/
│   ├── modules/
│   │   └── openseo/
│   │       ├── index.ts                    # Module entry point
│   │       ├── service.ts                  # Core service (Medusa Service)
│   │       ├── client.ts                   # Typed OpenSEO client
│   │       ├── types.ts                    # Shared types
│   │       ├── events/
│   │       │   ├── product.ts              # Subscribers for product events
│   │       │   ├── collection.ts
│   │       │   └── cron.ts                 # Weekly scheduled job
│   │       ├── utils/
│   │       │   ├── idempotency.ts          # Redis lock helper
│   │       │   └── mapping.ts              # Medusa ↔ OpenSEO transforms
│   │       └── admin/
│   │           └── widgets/
│   │               └── seo-score.tsx       # Admin UI widget (later)
│   └── api/
│       └── admin/
│           └── products/
│               └── [id]/
│                   └── seo/
│                       └── route.ts        # Admin "Run Audit" endpoint
```

### 2.1 Types (`types.ts`)

```ts
// src/modules/openseo/types.ts
export interface OpenSeoConfig {
  workerUrl: string; // e.g. https://openseo-xyz.workers.dev
  apiKey: string; // Long-lived Bearer token from OpenSEO
  projectId?: string; // Cached after first create
}

export interface ProductSeoMetadata {
  auditScore?: number;
  topIssues?: Array<{
    code: string;
    message: string;
    severity: "critical" | "high" | "medium" | "low";
  }>;
  schemaJsonLd?: string;
  lastAuditedAt?: string;
  auditId?: string;
}

export interface RankTrackingConfig {
  keywords: Array<{ keyword: string; url: string; locale?: string }>;
  schedule: "daily" | "weekly";
}

export interface DriftAlert {
  url: string;
  type: "rank_drop" | "schema_lost" | "new_404" | "canonical_changed";
  previous: unknown;
  current: unknown;
  detectedAt: string;
}
```

### 2.2 Client (`client.ts`) — Thin typed wrapper

```ts
// src/modules/openseo/client.ts
import type { OpenSeoConfig, ProductSeoMetadata } from "./types";

export class OpenSeoClient {
  constructor(private config: OpenSeoConfig) {}

  private async request<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.config.workerUrl}/api${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(
        `OpenSEO ${res.status}: ${err.message ?? res.statusText}`,
      );
    }
    return res.json();
  }

  // Project
  async ensureProject(storeDomain: string, dataforseoKey?: string) {
    if (this.config.projectId) return this.config.projectId;
    const { projectId } = await this.request<{ projectId: string }>(
      "/projects/create",
      {
        name: storeDomain,
        domain: storeDomain,
        dataforseoApiKey: dataforseoKey,
      },
    );
    this.config.projectId = projectId;
    return projectId;
  }

  // Audit
  async startAudit(
    url: string,
    options?: { maxPages?: number; runLighthouse?: boolean },
  ) {
    const projectId = await this.ensureProject(new URL(url).hostname);
    return this.request<{ auditId: string }>("/audit/start", {
      projectId,
      url,
      ...options,
    });
  }

  async pollAudit(
    auditId: string,
    projectId: string,
    intervalMs = 3000,
    timeoutMs = 120000,
  ) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const { status, issues } = await this.request<{
        status: string;
        issues?: any[];
      }>("/audit/status", { projectId, auditId });
      if (status === "completed") return { status, issues };
      if (status === "failed") throw new Error(`Audit failed: ${auditId}`);
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error("Audit timeout");
  }

  async getAuditIssues(projectId: string, auditId: string) {
    return this.request<{ issues: any[] }>("/audit/issues", {
      projectId,
      auditId,
    });
  }

  // Rank Tracking
  async createRankTracker(keywords: Array<{ keyword: string; url: string }>) {
    const projectId = await this.ensureProject(
      new URL(keywords[0]?.url).hostname,
    );
    return this.request<{ trackerId: string }>("/rank-tracker/create", {
      projectId,
      keywords,
    });
  }

  async runRankTracker(trackerId: string) {
    const projectId = this.config.projectId!;
    return this.request<{ runId: string }>("/rank-tracker/run", {
      projectId,
      trackerId,
    });
  }

  async getRankTracker(trackerId: string) {
    const projectId = this.config.projectId!;
    return this.request<{ keywords: any[] }>("/rank-tracker/get", {
      projectId,
      trackerId,
    });
  }

  // Schema / Structured Data (future: when seo-schema MCP tool exists)
  async getSchema(url: string) {
    const projectId = await this.ensureProject(new URL(url).hostname);
    return this.request<{ schemaJsonLd: string }>("/schema/get", {
      projectId,
      url,
    });
  }
}
```

### 2.3 Idempotency Helper (`utils/idempotency.ts`)

```ts
// src/modules/openseo/utils/idempotency.ts
import { InjectManager } from "@medusajs/medusa";
import { EntityManager } from "@mikro-orm/knex";

export async function withIdempotency<T>(
  manager: EntityManager,
  key: string,
  ttlSeconds: number,
  work: () => Promise<T>,
): Promise<T | null> {
  const lockKey = `openseo:lock:${key}`;
  const acquired = await manager.getConnection().execute(
    `
    INSERT INTO job_locks (key, expires_at)
    VALUES ($1, NOW() + INTERVAL '${ttlSeconds} seconds')
    ON CONFLICT (key) DO NOTHING
    RETURNING key
  `,
    [lockKey],
  );

  if (acquired.length === 0) return null; // already running

  try {
    return await work();
  } finally {
    await manager
      .getConnection()
      .execute(`DELETE FROM job_locks WHERE key = $1`, [lockKey]);
  }
}
```

> **Migration needed:** Add `job_locks` table (key PK, expires_at timestamptz).

### 2.4 Service (`service.ts`) — Medusa Service

```ts
// src/modules/openseo/service.ts
import { MedusaService } from "@medusajs/framework/utils";
import { OpenSeoClient } from "./client";
import type { OpenSeoConfig, ProductSeoMetadata, DriftAlert } from "./types";
import { withIdempotency } from "./utils/idempotency";
import { InjectManager } from "@medusajs/medusa";
import { EntityManager } from "@mikro-orm/knex";

class OpenSeoModuleService extends MedusaService({
  // No custom entities for MVP — we write to product.metadata
}) {
  private client: OpenSeoClient;

  constructor(
    { config }: { config: OpenSeoConfig },
    @InjectManager() private readonly manager: EntityManager,
  ) {
    super({}, {} as any); // MedusaService requires this signature
    this.client = new OpenSeoClient(config);
  }

  // Called by product subscriber
  async auditProduct(
    productHandle: string,
    storefrontUrl: string,
    options?: { runLighthouse?: boolean; idempotencyKey?: string },
  ): Promise<ProductSeoMetadata | null> {
    const url = `${storefrontUrl}/products/${productHandle}`;
    const key = options?.idempotencyKey ?? `product:${productHandle}:audit`;

    return withIdempotency(this.manager, key, 600, async () => {
      const { auditId } = await this.client.startAudit(url, {
        maxPages: 1,
        runLighthouse: options?.runLighthouse ?? false,
      });
      const projectId = this.client["config"].projectId!;
      const { issues } = await this.client.pollAudit(auditId, projectId);

      // Transform OpenSEO issues → Medusa metadata shape
      const critical =
        issues?.filter((i) => i.severity === "critical").slice(0, 3) ?? [];
      const score = this.computeScore(issues);

      const metadata: ProductSeoMetadata = {
        auditScore: score,
        topIssues: critical.map((i) => ({
          code: i.type,
          message: i.description,
          severity: i.severity,
        })),
        lastAuditedAt: new Date().toISOString(),
        auditId,
      };

      // TODO: fetch schemaJsonLd when seo-schema tool exists
      return metadata;
    });
  }

  // Called by weekly cron
  async runWeeklyRankCheck(): Promise<DriftAlert[]> {
    const projectId = this.client["config"].projectId!;
    if (!projectId) return [];

    // 1. Run all trackers
    // (assumes you store trackerIds per project in config or DB)
    // const trackers = await this.getTrackersForProject(projectId)
    // for (const t of trackers) await this.client.runRankTracker(t.trackerId)

    // 2. Get results + diff (simplified — real impl stores last positions)
    // const { keywords } = await this.client.getRankTracker(trackerId)
    // const alerts = this.diffPositions(keywords, lastPositions)

    // 3. For each alert URL, run single-page audit + drift compare
    // const driftAlerts: DriftAlert[] = []
    // for (const alert of alerts) { ... }

    return []; // placeholder
  }

  private computeScore(issues: any[]): number {
    if (!issues?.length) return 100;
    const weights = { critical: 25, high: 10, medium: 5, low: 2 };
    const penalty = issues.reduce(
      (sum, i) => sum + (weights[i.severity] ?? 0),
      0,
    );
    return Math.max(0, 100 - penalty);
  }
}

export default OpenSeoModuleService;
```

### 2.5 Event Subscribers (`events/product.ts`)

```ts
// src/modules/openseo/events/product.ts
import { SubscriberArgs, SubscriberConfig } from "@medusajs/framework";
import OpenSeoModuleService from "../service";

export default async function productEventHandler({
  event,
  container,
}: SubscriberArgs) {
  const openseo = container.resolve("openseo") as OpenSeoModuleService;
  const storefrontUrl = process.env.STOREFRONT_URL!;

  if (event.name === "product.created" || event.name === "product.updated") {
    const product = event.data as {
      id: string;
      handle: string;
      version: number;
    };
    const isSeoFieldChange =
      event.name === "product.created" ||
      ["title", "description", "handle", "thumbnail", "metadata"].some((f) =>
        (event as any).changedFields?.includes(f),
      );

    if (!isSeoFieldChange) return;

    const metadata = await openseo.auditProduct(product.handle, storefrontUrl, {
      idempotencyKey: `product:${product.id}:v${product.version}:audit`,
    });

    if (metadata) {
      // Write back to product.metadata.seo
      await container
        .resolve("productModuleService")
        .updateProducts(product.id, {
          metadata: {
            ...(event.data.metadata ?? {}),
            seo: metadata,
          },
        });
    }
  }

  if (event.name === "product.deleted" || event.name === "product.archived") {
    const product = event.data as { id: string; handle: string };
    // Remove from rank tracker, flag in OpenSEO context
    // await openseo.cleanupProduct(product.handle)
  }
}

export const config: SubscriberConfig = {
  event: [
    "product.created",
    "product.updated",
    "product.deleted",
    "product.archived",
  ],
  context: { subscriberId: "openseo-product-handler" },
};
```

### 2.6 Weekly Cron (`events/cron.ts`)

```ts
// src/modules/openseo/events/cron.ts
import { SubscriberArgs, SubscriberConfig } from "@medusajs/framework";
import OpenSeoModuleService from "../service";

export default async function weeklySeoCron({ container }: SubscriberArgs) {
  const openseo = container.resolve("openseo") as OpenSeoModuleService;
  const alerts = await openseo.runWeeklyRankCheck();

  if (alerts.length > 0) {
    // Send to Slack, email, or Medusa notifications
    for (const alert of alerts) {
      await container.resolve("notificationModuleService").createNotifications({
        to: "admin@example.com",
        template: "seo-drift-alert",
        data: alert,
      });
    }
  }
}

export const config: SubscriberConfig = {
  event: "scheduled:weekly", // Configure in medusa-config.ts crons
  context: { subscriberId: "openseo-weekly-cron" },
};
```

> **Medusa config:** Add to `medusa-config.ts`:
>
> ```ts
> export const crons = [
>   { name: "weekly-seo", schedule: "0 6 * * 1", handler: "scheduled:weekly" },
> ];
> ```

### 2.7 Admin "Run Audit" Endpoint (`api/admin/products/[id]/seo/route.ts`)

```ts
// src/api/admin/products/[id]/seo/route.ts
import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import OpenSeoModuleService from "../../../../../modules/openseo/service";

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const openseo = req.scope.resolve("openseo") as OpenSeoModuleService;
  const productId = req.params.id;
  const storefrontUrl = process.env.STOREFRONT_URL!;

  // Fetch product to get handle
  const productModule = req.scope.resolve("productModuleService");
  const product = await productModule.retrieveProduct(productId);

  const metadata = await openseo.auditProduct(product.handle, storefrontUrl, {
    runLighthouse: true,
    idempotencyKey: `admin:${req.user?.id}:product:${productId}`,
  });

  res.json({ success: true, metadata });
}
```

---

## 3. Medusa Config Registration

```ts
// medusa-config.ts
import { defineConfig } from "@medusajs/framework";
import OpenSeoModuleService from "./src/modules/openseo/service";

export default defineConfig({
  modules: [
    {
      resolve: "./src/modules/openseo",
      options: {
        workerUrl: process.env.OPENSEO_WORKER_URL!,
        apiKey: process.env.OPENSEO_API_KEY!,
      },
    },
    // ... your other modules
  ],
  crons: [
    { name: "weekly-seo", schedule: "0 6 * * 1", handler: "scheduled:weekly" },
  ],
});
```

**Environment variables (Medusa `.env`):**

```
OPENSEO_WORKER_URL=https://openseo-yourname.workers.dev
OPENSEO_API_KEY=sk_live_xxxxxxxxxxxx   # Generate in OpenSEO Worker (see below)
STOREFRONT_URL=https://your-store.com
```

---

## 4. Generate OpenSEO API Key (Machine-to-Machine)

OpenSEO Worker uses Bearer tokens for server-function auth. Create a long-lived key:

```bash
# On your OpenSEO Worker (via Cloudflare dashboard or wrangler)
# The Worker uses autumn-js + custom auth — add a service key:
wrangler secret put OPENSEO_SERVICE_KEY
# Value: openssl rand -hex 32
```

Then in `src/server/mcp/context.ts` (or wherever `withMcpProjectAuth` validates), accept `OPENSEO_SERVICE_KEY` as a valid Bearer for server-to-server calls. Or reuse the existing `whoami` flow with a pre-created org/project.

**Simpler:** The Worker's server functions already use `getSession` from Better Auth. Create a "service user" in OpenSEO admin, generate an API key there, and use that as `OPENSEO_API_KEY`.

---

## 5. Storefront PDP Injection (Scenario 6-D)

In your Medusa storefront (Next.js / Remix / whatever):

```tsx
// app/products/[handle]/page.tsx (Next.js App Router example)
import { getProduct } from "@/lib/medusa";

export default async function ProductPage({
  params,
}: {
  params: { handle: string };
}) {
  const product = await getProduct(params.handle);

  return (
    <>
      <head>
        {product.metadata?.seo?.schemaJsonLd && (
          <script
            type="application/ld+json"
            dangerouslySetInnerHTML={{
              __html: product.metadata.seo.schemaJsonLd,
            }}
          />
        )}
      </head>
      {/* ... rest of PDP */}
    </>
  );
}
```

---

## 6. Merchant DataForSEO Key Flow (Scenario 5-A)

### Medusa Admin: Add DataForSEO Key Field

```ts
// src/api/admin/stores/[id]/dataforseo/route.ts
// POST — merchant saves their DataForSEO login:password (encrypted)
// GET — masked display
```

### On Project Create / Update

```ts
// In openseo service ensureProject()
async ensureProject(storeDomain: string, merchantDataforseoKey?: string) {
  if (this.config.projectId) return this.config.projectId

  const { projectId } = await this.request<{ projectId: string }>('/projects/create', {
    name: storeDomain,
    domain: storeDomain,
    dataforseoApiKey: merchantDataforseoKey
      ? Buffer.from(merchantDataforseoKey).toString('base64')
      : undefined, // falls back to platform key in Worker env
  })
  this.config.projectId = projectId
  return projectId
}
```

---

## 7. Testing Checklist

| Test                               | Command                                                                                                                                                        |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker health                      | `curl https://your-openseo.workers.dev/api/health`                                                                                                             |
| Create project                     | `curl -X POST -H "Authorization: Bearer $KEY" -d '{"name":"test","domain":"test.com"}' https://your-openseo.workers.dev/api/projects/create`                   |
| Start audit                        | `curl -X POST -H "Authorization: Bearer $KEY" -d '{"projectId":"...","url":"https://test.com/products/tee"}' https://your-openseo.workers.dev/api/audit/start` |
| Medusa product create → audit runs | Check `product.metadata.seo` after save                                                                                                                        |
| Weekly cron fires                  | `npm run dev` → trigger cron manually → check alerts                                                                                                           |

---

## 8. Cost Estimate (DataForSEO)

| Operation                            | DataForSEO Units     | Est. Cost   |
| ------------------------------------ | -------------------- | ----------- |
| Single PDP audit (50 pages)          | ~50 on-page checks   | ~$0.10      |
| Keyword research (10 seeds)          | 10 keyword metrics   | ~$0.02      |
| Rank tracking (100 keywords, weekly) | 100 rank checks/week | ~$0.20/week |
| **Typical store/month**              |                      | **$2–5**    |

Merchant pays directly via their DataForSEO account. OpenSEO adds 0% markup (self-hosted).

---

## 9. Future Extensions (Post-MVP)

| Feature                                        | OpenSEO Skill            | Medusa Integration                                              |
| ---------------------------------------------- | ------------------------ | --------------------------------------------------------------- |
| Content briefs for product descriptions        | `seo-content-brief`      | Admin "Generate Brief" button → writes to `product.description` |
| Schema generation (Product, Offer, Breadcrumb) | `seo-schema`             | Auto-inject JSON-LD on PDP                                      |
| Collection keyword map                         | `keyword-clustering`     | `collection.metadata.seo_keyword_map` for content team          |
| Competitor "X vs Y" pages                      | `seo-competitor-pages`   | Auto-generate comparison pages for top competitors              |
| Local SEO for physical stores                  | `seo-local` + `seo-maps` | If Medusa has `store_locations` entity                          |

---

## 10. Rollback / Safety

- All writes to Medusa are **additive** (`product.metadata.seo` only) — no core fields touched
- OpenSEO Worker is stateless except D1/Postgres — redeploy anytime
- Idempotency keys prevent double-spend on DataForSEO
- Feature flag: `OPENSEO_ENABLED=false` disables all subscribers instantly

---

## TL;DR for Your Team

> **Copy `src/modules/openseo/` into your Medusa repo. Deploy the OpenSEO Worker on Cloudflare (30 min). Add 3 env vars. Done.**
>
> - Product save → 30s later → SEO score + 3 fixes in Medusa admin
> - Monday 6 AM → Slack: "3 keywords dropped, 1 page lost schema"
> - Merchant brings own DataForSEO key → pays ~$3/mo directly
> - No React UI work unless you want the admin widget later
