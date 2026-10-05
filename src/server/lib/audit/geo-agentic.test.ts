import { describe, expect, it } from "vitest";
import {
  checkAgenticReadiness,
  type AgenticReadinessInput,
  type AgenticReadyResult,
} from "@/server/lib/audit/geo-agentic";
import {
  markdownGate,
  parseRobots,
  robotsGate,
  type MarkdownProbe,
  type RobotsRule,
} from "@/server/lib/audit/geo-agentic-robots";

const URL = "https://example.com/guide";

function healthyPage(): string {
  return `<html><head><title>Guide</title>
<link rel="alternate" type="text/markdown" href="/guide.md">
</head><body><h1>Guide</h1><p>${"Helpful human-written guidance. ".repeat(60)}</p>
<form action="/search"><input name="q"></form></body></html>`;
}

function healthyInput(): AgenticReadinessInput {
  return {
    url: URL,
    html: healthyPage(),
    robotsTxt: "User-agent: *\nAllow: /\n",
    robotsStatus: 200,
    llmsTxt: {
      status: 200,
      text: "# Example\n\n> A summary.\n\n## Docs\n\n- [Guide](https://example.com/guide): the guide.\n",
    },
    markdownProbe: {
      status: 200,
      contentType: "text/markdown; charset=utf-8",
      vary: "Accept",
    },
    aiCatalog: null,
  };
}

function gate(result: AgenticReadyResult, code: string) {
  const found = result.gates.find((item) => item.code === code);
  if (!found) throw new Error(`missing gate ${code}`);
  return found;
}

describe("checkAgenticReadiness", () => {
  it("passes a healthy site and reports ready", () => {
    const result = checkAgenticReadiness(healthyInput());
    expect(result.url).toBe(URL);
    expect(result.ready).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(90);
    expect(gate(result, "server-rendered").status).toBe("pass");
    expect(gate(result, "robots-txt").status).toBe("pass");
    expect(gate(result, "llms-txt").status).toBe("pass");
    expect(gate(result, "markdown-delivery").status).toBe("pass");
    expect(gate(result, "headings").status).toBe("pass");
    expect(gate(result, "ard-catalog").status).toBe("na");
  });

  it("fails P0 gates on shells and warns on blocked search crawlers", () => {
    const result = checkAgenticReadiness({
      url: URL,
      html: `<html><body><div id="root"></div><script src="/app.js"></script></body></html>`,
      robotsTxt:
        "User-agent: *\nAllow: /\n\nUser-agent: OAI-SearchBot\nDisallow: /\n",
      robotsStatus: 200,
      llmsTxt: { status: 404, text: "" },
    });
    expect(gate(result, "server-rendered").status).toBe("fail");
    expect(gate(result, "server-rendered").passed).toBe(false);
    expect(gate(result, "robots-txt").status).toBe("warn");
    expect(gate(result, "llms-txt").status).toBe("info");
    expect(result.score).toBeLessThan(
      checkAgenticReadiness(healthyInput()).score,
    );
  });

  it("blocks readiness when robots.txt errors server-side", () => {
    const input: AgenticReadinessInput = {
      url: URL,
      html: healthyPage(),
      robotsTxt: "",
      robotsStatus: 500,
    };
    expect(gate(checkAgenticReadiness(input), "robots-txt").status).toBe(
      "fail",
    );
    expect(checkAgenticReadiness(input).ready).toBe(false);
  });

  it("honours RFC 9309 group selection: named groups replace the star group", () => {
    const result = checkAgenticReadiness({
      url: URL,
      html: healthyPage(),
      robotsTxt: "User-agent: *\nAllow: /\n\nUser-agent: GPTBot\nDisallow: /\n",
      robotsStatus: 200,
    });
    expect(gate(result, "robots-txt").status).toBe("pass");
  });

  it("flags Content-Signal format issues inside the robots gate", () => {
    const result = checkAgenticReadiness({
      url: URL,
      html: healthyPage(),
      robotsTxt:
        "User-agent: *\nAllow: /\nContent-Signal: search=maybe, bogus=yes\n",
      robotsStatus: 200,
    });
    expect(gate(result, "robots-txt").status).toBe("warn");
  });

  it("rejects soft-404 llms.txt and broken catalogs", () => {
    const soft = checkAgenticReadiness({
      url: URL,
      html: healthyPage(),
      llmsTxt: {
        status: 200,
        text: "<!DOCTYPE html><html><body>Nope</body></html>",
      },
    });
    expect(gate(soft, "llms-txt").status).toBe("fail");
    const badCatalog = checkAgenticReadiness({
      url: URL,
      html: healthyPage(),
      aiCatalog: {
        signalled: true,
        status: 200,
        contentType: "application/json",
        text: '{"entries": [{"displayName": "No URN"}]}',
      },
    });
    const ard = gate(badCatalog, "ard-catalog");
    expect(ard.status).toBe("fail");
    expect(ard.passed).toBe(false);
  });

  it("validates a well-formed ai-catalog.json", () => {
    const result = checkAgenticReadiness({
      url: URL,
      html: healthyPage(),
      aiCatalog: {
        signalled: true,
        status: 200,
        contentType: "application/ai-catalog+json",
        text: JSON.stringify({
          specVersion: "1.0",
          entries: [
            {
              identifier: "urn:air:example:docs",
              displayName: "Docs",
              type: "application/mcp-server-card+json",
              url: "https://example.com/mcp",
              representativeQueries: ["how to use", "pricing"],
            },
          ],
        }),
      },
    });
    expect(gate(result, "ard-catalog").status).toBe("pass");
  });

  it("warns on Markdown negotiation without Vary: Accept", () => {
    const result = checkAgenticReadiness({
      url: URL,
      html: healthyPage(),
      markdownProbe: { status: 200, contentType: "text/markdown", vary: "" },
    });
    expect(gate(result, "markdown-delivery").status).toBe("warn");
  });

  it("detects cloaking when the rendered body drops content", () => {
    const full = `<html><body><h1>T</h1><p>${"Real content paragraph. ".repeat(80)}</p></body></html>`;
    const result = checkAgenticReadiness({
      url: URL,
      html: full,
      renderedHtml: "<html><body><p>Teaser only.</p></body></html>",
    });
    expect(gate(result, "no-cloaking").status).toBe("warn");
    const untested = checkAgenticReadiness({ url: URL, html: full });
    expect(gate(untested, "no-cloaking").status).toBe("na");
  });

  it("scans WebMCP hints statically from inline markup", () => {
    const result = checkAgenticReadiness({
      url: URL,
      html: `<html><body><h1>T</h1><p>${"Content. ".repeat(60)}</p>
<form toolname="search" tooldescription="Search docs"><input name="q"></form>
<script>document.modelContext.registerTool({name: "search"});</script></body></html>`,
    });
    expect(gate(result, "webmcp-tools").status).toBe("pass");
    expect(gate(result, "webmcp-entry-point").status).toBe("pass");
    expect(gate(result, "webmcp-form-annotations").status).toBe("pass");
  });

  it("scores headings and structured-data availability", () => {
    const headed = checkAgenticReadiness(healthyInput());
    expect(gate(headed, "headings").status).toBe("pass");
    expect(gate(headed, "structured-data").status).toBe("info");
    const bare = checkAgenticReadiness({
      url: URL,
      html: "<html><body><p>Hi.</p></body></html>",
    });
    expect(gate(bare, "headings").status).toBe("warn");
    const withSchema = checkAgenticReadiness({
      url: URL,
      html: `<html><body><h1>T</h1><script type="application/ld+json">{"@type":"Article"}</script></body></html>`,
    });
    expect(gate(withSchema, "structured-data").status).toBe("pass");
  });
});

describe("robots module contract", () => {
  it("parses groups into typed rules", () => {
    const parsed = parseRobots("User-agent: *\nDisallow: /admin\n");
    const rules: RobotsRule[] = parsed.groups[0]?.rules ?? [];
    expect(rules).toEqual([{ field: "disallow", value: "/admin" }]);
  });

  it("evaluates probes typed as MarkdownProbe", () => {
    const probe: MarkdownProbe = {
      status: 200,
      contentType: "text/markdown",
      vary: "",
    };
    expect(markdownGate("<html></html>", probe).status).toBe("warn");
    expect(markdownGate("<html></html>", null).status).toBe("info");
  });

  it("gates robots access for AI search crawlers", () => {
    const open = parseRobots("User-agent: *\nAllow: /\n");
    expect(robotsGate(open, 200).status).toBe("pass");
    const closed = parseRobots("User-agent: *\nDisallow: /\n");
    expect(robotsGate(closed, 200).status).toBe("warn");
  });
});
