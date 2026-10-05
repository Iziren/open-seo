---
name: seo-geo
description: "Audit a page or site for AI-search citability (AI Overviews, ChatGPT, Perplexity): passage structure, entity and brand signals, crawler access, and freshness."
---

# OpenSEO AI Search Readiness (GEO)

## Goal

Judge whether a page's content can be quoted by AI search surfaces, and name the few changes most likely to earn citations. Frame findings as **SEO fundamentals applied to AI surfaces, not a separate discipline** — per Google's AI Optimization Guide (May 2026), "optimizing for generative AI search is optimizing for the search experience, and thus still SEO." When community advice contradicts Google's primary source, defer to Google and note the contradiction.

Use this when asked about AI Overviews visibility, ChatGPT/Perplexity citations, or "GEO". For agent-protocol readiness (Lighthouse Agentic Browsing, WebMCP, Markdown delivery), that is a separate future skill — note it as a gap, do not improvise it here.

## Required inputs

- `projectId` (`list_projects`; if no project matches, `create_project`).
- URL or domain to assess.

## Project context

1. Call `get_project_context` first and ground the assessment in it — the business, its key pages, and what AI queries its buyers actually ask.
2. Before spending credits, check the research log. Reuse results under 30 days old for discovery; a citability claim that drives a recommendation still needs a live read made during this assessment.
3. On finish, write back what is durable with `update_project_context` and append `{ appendResearchLog: { summary: "GEO assessment: <domain>. Verdict: <conclusion>" } }`.

## Deliver as a report

Deliver through the `seo-report` skill, saving with `skill: "seo-geo"`. If that skill is unavailable, say so and stop before writing HTML.

## OpenSEO MCP tools

- `whoami`: confirm connection and credits before spending.
- `run_site_audit`, then `get_audit_status`, `get_audit_issues`, `get_audit_pages`: structure signals (heading hierarchy, SSR vs client-only content, dates, schema presence). Leave Lighthouse off; performance is not this skill's question.
- `get_serp_results`: the ranking prerequisite — the large majority of AI Overview citations come from pages that already rank (roughly top-10). A page invisible in classic search is not citable; say so before scoring prose.
- `get_ranked_keywords`: which queries already send the target pages impressions — citability work starts on pages with a foothold.
- `get_search_console_performance`: when connected, first-party clicks/impressions separate "not cited because not seen" from "seen but not quoted".
- `get_keyword_metrics`, `research_keywords`: demand for the question-clusters the page should answer. One focused batch suffices.
- Web reading (fetch or in-app page read): the page itself, its `robots.txt`, and `/llms.txt` if present.

## Workflow

### 1. Check the bots before the prose

Read `robots.txt` and report each crawler **separately with the capability it governs**. Training access and search citability are distinct findings — never merge them into one line:

| Claim | Bot to check | Bot that does NOT support it |
|---|---|---|
| Citable in ChatGPT Search | `OAI-SearchBot` | `GPTBot` (training only) |
| Citable in Claude search | `Claude-SearchBot` | `ClaudeBot` (training only) |
| Eligible for Google AI Overviews / AI Mode | `Googlebot` | `Google-Extended` (Gemini/Vertex training only) |
| Discoverable via Siri / Spotlight | `Applebot` | `Applebot-Extended` (training opt-out label only) |

A site blocking `GPTBot` while allowing `OAI-SearchBot` is fully citable in ChatGPT Search. A blocked `Google-Extended` is never evidence of missing Google Search visibility. User-triggered fetchers (`ChatGPT-User`, `Google-Agent`, Perplexity-User) largely ignore `robots.txt` — do not score them as controls.

### 2. Score the five citability criteria

| Criterion | Weight | What earns it |
|---|---|---|
| Self-contained answer blocks | 25% | Quotable sentences with specific facts; direct answer in the first 40–60 words of a section; claims with attributed sources; "X is…" definitions; unique data. Front-load: a large share of AI citations comes from the first third of a page. (~130–170 words per block is a readability heuristic, not a Google rule.) |
| Structural readability | 20% | Clean H1→H2→H3; question-based headings matching query patterns; short paragraphs; tables for comparisons; lists for steps; Q&A format for FAQs. |
| Authority and brand signals | 20% | Named author with credentials; publication and updated dates; citations to primary sources; entity presence (Wikipedia/Wikidata, YouTube, Reddit, LinkedIn). Brand mentions correlate more strongly with AI citation than backlinks — report presence per platform, do not invent scores. |
| Technical accessibility | 20% | Content in server-rendered HTML (several AI crawlers do not execute JavaScript; Googlebot does). SSR gaps found in the audit are citability blockers — say so. |
| Multi-modal support | 15% | Relevant images, embedded video, charts, tools/calculators with supporting structured data. Supporting signal only. |

`llms.txt` carries **zero weight** for Google (explicit in the AI Optimization Guide, June 2026 clarification) — report presence/absence in one line for non-Google systems only, never as a recommendation with citation impact.

### 3. Freshness check

Recency is one of the highest-leverage plays: recently-updated content is substantially more likely to be cited, and stale pages lose eligibility. Flag pages untouched for 6+ months that target fast-moving queries, and recommend a refresh cadence — not a rewrite.

### 4. Shortlist, then write

Three or fewer recommendations, each naming the page, the observed gap, the evidence (query, current rank, date), and the main uncertainty. Platform scores (Google AIO, ChatGPT, Perplexity) appear **only when measured with a tool**; otherwise report qualitative readiness and say it was not measured.

## Output format

Use the title conventions in `seo-report`. Sections, in order:

1. **AI-search verdict**: two or three bullets — readiness state, the one change that matters most, what is already working.
2. **Crawler access**: one row per checked bot — allowed/blocked and what that governs.
3. **Citability findings**: per-criterion score and the observed evidence, with the passages to rewrite quoted or linked.
4. **Recommendations**: one to three, each with Do this / Why (gap, who searches, plausible benefit, uncertainty).
5. **How this report was made**: the fixed skill link line from `seo-report` (URL `https://openseo.so/docs/skills/seo-geo`, text "OpenSEO AI Search Readiness skill"), coverage and limits, then a closed-by-default evidence block (queries checked, ranks, dates, sources).

## Guardrails

- Never tie advice to a Gemini/AI Mode model version — Google rotates them; it dates the report on arrival.
- Third-party statistics (citation shares, user counts) ship with source and date or not at all.
- `nosnippet`, `data-nosnippet`, `max-snippet`, and the Search Console "Search generative AI" control govern AI-feature appearance — not `llms.txt`, not training-crawler blocks. Keep the mechanism attached to each claim.
- If the page does not rank for its target query, the recommendation is classic SEO first (rank before citability), not GEO tweaks.
