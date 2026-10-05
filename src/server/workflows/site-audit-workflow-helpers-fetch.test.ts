import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCrawlThrottle } from "@/server/lib/audit/crawl-throttle";
import { crawlPage } from "@/server/workflows/site-audit-workflow-helpers";

const PAGE_URL = "https://example.com/page";
const PAGE_HTML =
  "<html><head><title>A page</title></head><body><h1>A page</h1></body></html>";
const SHELL_HTML =
  '<html><head><title>App</title></head><body><div id="root"></div>' +
  '<script defer src="/assets/app.js"></script></body></html>';
const RENDERED_HTML =
  `<html><head><title>Rendered docs</title></head><body><h1>Docs</h1><p>` +
  `${Array.from({ length: 80 }, (_, i) => `word${i}`).join(" ")}</p></body></html>`;

/**
 * Answer each fetch with the next reply, repeating the last one. Every call
 * builds a fresh Response: a body can only be read (or cancelled) once.
 */
function stubFetch(...replies: Array<{ status: number; retryAfter?: string }>) {
  let index = 0;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    const reply = replies[Math.min(index++, replies.length - 1)];
    return new Response(PAGE_HTML, {
      status: reply.status,
      headers: {
        "content-type": "text/html",
        ...(reply.retryAfter ? { "retry-after": reply.retryAfter } : {}),
      },
    });
  });
}

function crawl() {
  return crawlPage(
    PAGE_URL,
    0,
    false,
    createCrawlThrottle(Date.now() + 90_000),
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("crawlPage fetch bounds, redirect cap, and app shells", () => {
  it("bounds the raw fetch at the thirty second page timeout", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchMock = stubFetch({ status: 200 });

    const page = await crawl();

    expect(page?.fetchClass).toBe("ok");
    expect(timeoutSpy).toHaveBeenCalledWith(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    timeoutSpy.mockRestore();
  });

  it("records the redirect target while the chain is under the cap", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(null, {
          status: 301,
          headers: { location: "https://example.com/next" },
        }),
    );
    const throttle = createCrawlThrottle(Date.now() + 90_000);

    const page = await crawlPage(PAGE_URL, 0, false, throttle, 4);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(page?.fetchClass).toBe("ok");
    expect(page?.statusCode).toBe(301);
    expect(page?.redirectUrl).toBe("https://example.com/next");
  });

  it("stops a redirect chain at the fifth followed hop", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(null, {
          status: 301,
          headers: { location: "https://example.com/next" },
        }),
    );
    const throttle = createCrawlThrottle(Date.now() + 90_000);

    const page = await crawlPage(PAGE_URL, 0, false, throttle, 5);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(page?.statusCode).toBe(301);
    expect(page?.fetchClass).toBe("error");
    expect(page?.redirectUrl).toBeNull();
  });

  it("re-fetches an app shell as Googlebot and analyzes the rendered body", async () => {
    const userAgents: Array<string | null> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      userAgents.push(new Headers(init?.headers).get("user-agent"));
      return new Response(
        userAgents.length === 1 ? SHELL_HTML : RENDERED_HTML,
        {
          headers: { "content-type": "text/html" },
        },
      );
    });

    const page = await crawl();

    expect(userAgents).toEqual([
      "OpenSEO-Audit/1.0",
      "Googlebot/2.1 (+http://www.google.com/bot.html)",
    ]);
    expect(page?.title).toBe("Rendered docs");
    expect(page?.spaShell).toBe(false);
  });

  it("keeps the shell verdict when Googlebot is served the same shell", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(SHELL_HTML, {
          headers: { "content-type": "text/html" },
        }),
    );

    const page = await crawl();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(page?.spaShell).toBe(true);
  });

  it("defers the URL when the chunk budget expires before the probe", async () => {
    vi.useFakeTimers();
    let calls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      calls += 1;
      // Burn the chunk's remaining budget right after the raw fetch, so the
      // probe's throttle check refuses instead of issuing a second request.
      if (calls === 1) vi.setSystemTime(Date.now() + 60_000);
      return new Response(SHELL_HTML, {
        headers: { "content-type": "text/html" },
      });
    });
    const throttle = createCrawlThrottle(Date.now() + 5_000);

    expect(await crawlPage(PAGE_URL, 0, false, throttle)).toBeNull();
    expect(calls).toBe(1);
  });
});

describe("crawlPage queued results", () => {
  it("does not retain large source HTML in queued crawl results", () => {
    // A dedicated V8 process makes GC available without depending on the test
    // runner's heap. Exercise the real reader/parser with separate streamed
    // bodies; keeping just their titles used to retain every 1 MiB document.
    const result = spawnSync(
      process.execPath,
      [
        "--expose-gc",
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `
          import assert from "node:assert/strict";
          import { crawlPage } from ${JSON.stringify(new URL("./site-audit-workflow-helpers.ts", import.meta.url).href)};
          import { createCrawlThrottle } from ${JSON.stringify(new URL("../lib/audit/crawl-throttle.ts", import.meta.url).href)};
          const throttle = createCrawlThrottle(Date.now() + 90_000);
          globalThis.fetch = async () => {
            const html = '<title>Example memory regression 🌱</title>' +
              '<meta name="description" content="A small description">' +
              '<script>' + 'x'.repeat(1024 * 1024) + '</script>';
            const bytes = new TextEncoder().encode(html);
            let offset = 0;
            return new Response(new ReadableStream({
              pull(controller) {
                if (offset >= bytes.length) return controller.close();
                controller.enqueue(bytes.subarray(offset, offset + 65536));
                offset += 65536;
              },
            }), { headers: { "content-type": "text/html" } });
          };
          const collect = async () => {
            await new Promise(resolve => setTimeout(resolve, 0));
            globalThis.gc();
            globalThis.gc();
            const { heapUsed, external } = process.memoryUsage();
            return heapUsed + external;
          };
          await crawlPage("https://example.com/warmup", 0, true, throttle);
          const before = await collect();
          const pages = [];
          for (let i = 0; i < 50; i++) {
            pages.push(await crawlPage("https://example.com/" + i, 0, true,
              createCrawlThrottle(Date.now() + 90_000)));
          }
          const retained = (await collect()) - before;
          assert.equal(pages.length, 50);
          assert.equal(pages[49].title, "Example memory regression 🌱");
          assert.ok(retained < 16 * 1024 * 1024,
            "Queued results retained " + retained + " bytes of source HTML");
        `,
      ],
      { encoding: "utf8", timeout: 20_000 },
    );

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  }, 25_000);
});
