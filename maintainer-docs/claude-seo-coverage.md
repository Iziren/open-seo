# claude-seo → open-seo coverage ledger

Source: `AgriciDaniel/claude-seo` v2.4.0, 26 skills under `skills/*/SKILL.md`.
Rule: every skill below has a disposition. No skill is unaccounted for.

Dispositions: COVERED (no action) · MERGE (fold judgment into an existing
open-seo skill) · ADAPT (new `.agents/skills/` entry, MCP-first rewrite) ·
DEFER (extension or later phase) · DROP (do not import).

| #   | claude-seo skill       | Core function                                                                | open-seo today                                                             | Disposition                                                              |
| --- | ---------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 1   | `seo` (orchestrator)   | Industry detection, 17-agent fan-out, 0-100 scoring, falsifiable action plan | `seo-audit` skill + SAM orchestration                                      | MERGE scoring weights + falsifiability into `seo-audit`                  |
| 2   | `seo-audit`            | Full-site audit, scored report                                               | `seo-audit` skill, `run_site_audit` + issues/pages tools, Site Audit page  | MERGE 0-100 envelope + finding schema                                    |
| 3   | `seo-page`             | Single-URL deep review                                                       | `page-analyzer.ts` lib only, no skill/MCP                                  | ADAPT new (thin MCP wrapper over existing analyzer)                      |
| 4   | `seo-technical`        | Crawlability, indexability, CWV, security headers                            | Covered inside site audit crawl + issues                                   | MERGE as technical section of `seo-audit`, no separate skill             |
| 5   | `seo-content`          | E-E-A-T, readability, thin content, AI-pattern cleanup                       | Nothing                                                                    | ADAPT new                                                                |
| 6   | `seo-content-brief`    | Competitive briefs, outlines, density guidance                               | Nothing                                                                    | ADAPT new (first-class candidate)                                        |
| 7   | `seo-schema`           | Schema detect / validate / generate JSON-LD                                  | Structured-data signals inside page analyzer only                          | ADAPT new (needs schema MCP tools)                                       |
| 8   | `seo-geo`              | AI citability, crawler access, brand signals, passage structure              | Brand Lookup + Prompt Explorer pages (partial)                             | ADAPT new — DONE as reference (`.agents/skills/seo-geo/SKILL.md`)        |
| 9   | `seo-agentic`          | Lighthouse Agentic Browsing fraction, llms.txt, Markdown, WebMCP             | Nothing                                                                    | ADAPT new (needs agentic-check MCP tools)                                |
| 10  | `seo-cluster`          | SERP-overlap clustering, hub-and-spoke architecture                          | `keyword-clustering` skill exists                                          | MERGE overlap methodology into `keyword-clustering`                      |
| 11  | `seo-competitor-pages` | Generate "X vs Y" / alternatives pages                                       | `competitor-analysis` + `competitive-landscape` (analysis, not generation) | ADAPT as generation section extending `competitor-analysis`              |
| 12  | `seo-backlinks`        | Anchors, toxic signals, gaps, disavow candidates                             | Backlinks UI + MCP + `link-prospecting` (outreach side)                    | MERGE audit-side analysis into backlinks docs/skill section              |
| 13  | `seo-local`            | GBP, NAP, citations, reviews, local schema                                   | `local-seo` skill + local-seo MCP tools                                    | MERGE GBP deprecation linter + NAP checks                                |
| 14  | `seo-maps`             | Geo-grid tracking, GBP API audit, review intel, radius mapping               | `getLocalRankGrid` et al. in local-seo tools                               | MERGE after verifying review-intel / radius gaps                         |
| 15  | `seo-ecommerce`        | Product schema, Shopping visibility, marketplace signals                     | Nothing (DataForSEO Merchant API unused)                                   | ADAPT new, DEFERRED behind Merchant API credentials                      |
| 16  | `seo-hreflang`         | Hreflang audit, validation, generation                                       | Nothing                                                                    | ADAPT new (small, self-contained)                                        |
| 17  | `seo-images`           | Alt text, sizes, formats, lazy-load, CLS, IPTC                               | Image signals inside page analyzer only                                    | ADAPT new, or fold into `seo-page` if that lands first                   |
| 18  | `seo-image-gen`        | Gemini OG/hero/product image generation                                      | Nothing; requires Gemini + banana extension                                | DEFER as optional extension, not core                                    |
| 19  | `seo-sitemap`          | Sitemap analyze / generate with industry templates                           | Audit seeds sitemaps; no generate flow                                     | MERGE analyze side into audit; DEFER generate templates                  |
| 20  | `seo-sxo`              | SERP page-type mismatch, user stories, persona scoring                       | Nothing                                                                    | ADAPT new                                                                |
| 21  | `seo-drift`            | Baseline / diff / history of on-page SEO ("git for SEO")                     | Nothing                                                                    | ADAPT new — needs DB snapshots, i.e. first-class backend work            |
| 22  | `seo-plan`             | Industry-specific strategy templates + roadmap                               | `seo-coach` + `seo-project-setup` (partial)                                | MERGE industry templates into `seo-coach`                                |
| 23  | `seo-programmatic`     | Template engines, URL patterns, index-bloat guards                           | Nothing                                                                    | DEFER — niche; revisit after drift ships                                 |
| 24  | `seo-google`           | GSC, PageSpeed, CrUX + 25-week history, Indexing API, GA4                    | search-console-tools, google-analytics-tools, lighthouse feature           | COVERED — gaps (CrUX history, Indexing API) go to tool backlog, no skill |
| 25  | `seo-dataforseo`       | Live SERP/keyword/backlink data via DataForSEO MCP                           | dataforseo-research-tools (the data layer itself)                          | COVERED — no skill, it is infrastructure                                 |
| 26  | `seo-flow`             | Third-party FLOW framework prompts (CC BY 4.0, external project)             | Nothing                                                                    | DROP — link out only; external license + dependency                      |

## Adaptation rules (applied to `seo-geo`, mandatory for the rest)

1. MCP tools only — no `${CLAUDE_PLUGIN_ROOT}/scripts/*.py`, no local
   artifact folders, no WeasyPrint/Playwright CLI steps.
2. OpenSEO project-context contract: `get_project_context` first,
   30-day research-log reuse, `update_project_context` on finish.
3. Deliver through `seo-report` skill (`skill: "<name>"`); SAM's surface
   note automatically converts this to in-chat findings.
4. Reference only MCP tools that exist (`samChatTools.ts` is the source
   of truth for SAM; `server.ts` for external clients).
5. Distribution: `.agents/skills/` = SAM + repo source of truth.
   Add to `scripts/sync-plugin-skills.mjs` allowlist only when shipping
   to external plugin clients; `pnpm sync-plugin-skills` after any edit.
