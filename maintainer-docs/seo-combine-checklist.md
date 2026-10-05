# SEO build checklist — open-seo base + claude-seo ports

Base: `PrecisionHQ/open-seo` @ `0ffff93` (imported into cardinalfish).
Intelligence source: `AgriciDaniel/claude-seo` v2.4.0 (Python scripts + 26 skills + 19 agents).
Direction agreed: port Python logic to TypeScript workers, keep open-seo MCP as data layer.

## Phase 0 — Bootstrap (done / verify)

- [x] Add `origin` → `PrecisionHQ/open-seo`, fetch depth-1, reset `cardinalfish` to `origin/main`
- [ ] `corepack enable && pnpm install --frozen-lockfile` (blocked: corepack download timed out, retry on stable network)
- [ ] `cp .env.example .env.local` + `DATAFORSEO_API_KEY=base64(login:password)`
- [ ] `pnpm run db:migrate:local`
- [ ] `pnpm dev:agents` boots at `http://open-seo.localhost:1355`
- [ ] `pnpm test` green baseline before any port

## Phase 1 — Safety + fetch foundation

- [ ] Port `claude-seo/scripts/url_safety.py` → `src/server/features/audit/services/urlSafety.ts`
  - `validateUrl`, `validateUrlStrict` (DNS-pin), `isSafeIp`, `CLAUDE_SEO_LOCAL_TARGETS`→`SEO_LOCAL_TARGETS` allowlist
  - SSRF tests: private/loopback/link-local/multicast, trailing-dot FQDN, obfuscated IPv4, redirect-rebind
- [x] Port `fetch_page.py` → extend crawl fetcher (redirect chain ≤5, 30s timeout, Googlebot-UA variant for prerender detection)
- [ ] Port `sitemap_discovery.py` → sitemap + robots discovery used by audit orient step
- [ ] Acceptance: audit crawl of `badseo/` passes with no SSRF regressions, `pnpm test` + `oxlint` clean

## Phase 2 — Audits + technical + content + schema

- [x] Port `render_page.py` auto-mode (raw first, Playwright only on SPA shell) into `SiteAuditWorkflow` / `audit-worker.ts`
- [ ] Port `parse_html.py`, `content_quality.py`, `content_verify.py`, `nlp_analyze.py` → content services (E-E-A-T per QRG Sept 2025, Trust highest)
- [ ] Port `schema_generate.py` + `schema_ecommerce_validate.py` → schema feature
- [x] Port `pagespeed_check.py`, `crux_history.py`, `lcp_subparts.py`, `lighthouse_agentic.py` → `src/server/lib/audit/perf-{psi,crux,lcp}.ts` (+ optional `features/lighthouse/services/googlePageSpeedClient.ts`)
  - [x] Add 0-100 health score weights: Technical 22 / Content 23 / On-page 20 / Schema 10 / Perf 10 / AI 10 / Images 5
- [ ] Acceptance: full audit on `badseo` emits scored report, SPA fixture no longer false-negative

## Phase 3 — Keywords, rank tracking, drift

- [ ] Keep open-seo `research_keywords`, `get_ranked_keywords`, `get_serp_results` (live checks, depth 20)
- [ ] Port `seo-cluster` SERP-overlap methodology → `plugins/openseo/skills/keyword-clustering/` upgrade + cluster-map UI
- [x] Port `drift_baseline.py` / `drift_compare.py` / `drift_history.py` → `src/server/features/rank-tracking/services/` (SQLite snapshots, weekly compare)
- [x] Port `keyword_planner.py`, `domain_history.py` → keyword demand + history
- [ ] Acceptance: keyword → cluster → brief → tracked ranks → drift email/flag loop works

## Phase 4 — AI visibility / GEO + agentic

- [ ] Keep Brand Lookup + Prompt Explorer; add citability scorer (`seo-geo`: self-contained blocks, Q-headings, attribution density)
- [ ] Port `agentic_check.py` + `lighthouse_agentic.py` → `/seo agentic` gate (X/N fraction, llms.txt as discovery only, Markdown, `ai-catalog.json`, WebMCP)
- [ ] Add SE Ranking / Profound extension stubs behind credentials (never required for core)
- [ ] Acceptance: every full audit includes AI Search Readiness section with cited evidence

## Phase 5 — Skills + MCP + reporting merge

- [ ] Merge 26 claude-seo `SKILL.md` workflows into `plugins/openseo/skills/` (no overwrite of `seo-audit` shortlist-then-choose flow; add `opportunities.md` step + falsifiability fields)
- [ ] Emit `audit-data.json` envelope per audit → HTML/PDF report via existing `seo-report` skill
- [ ] Sync plugin registries (`pnpm sync-plugin-skills`), update `.claude-plugin`, `.cursor-plugin`, `.opencode`
- [ ] Acceptance: `pnpm ci:check` (prettier + knip + tsc + oxlint + skills sync) clean

## Notes / non-goals

- Hosting undecided: Docker for local, Cloudflare for team. No hosted billing changes in v1.
- Do not run Python sidecar long-term; TS ports only. `CLAUDE_PLUGIN_ROOT` script calls disappear as ports land.
- FAQPage/HowTo schema: do not generate (retired by Google May 2026 / Sept 2023).
- llms.txt is not a ranking lever; discovery file only.
