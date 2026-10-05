import { describe, expect, it, vi } from "vitest";
import {
  detectSpaShell,
  PAGE_FETCH_TIMEOUT_MS,
  resolvePageContent,
} from "@/server/lib/audit/render-page";

const PAGE_URL = "https://example.com/app";
const GOOGLEBOT_UA = "Googlebot/2.1 (+http://www.google.com/bot.html)";

function words(count: number) {
  return Array.from({ length: count }, (_, i) => `word${i}`).join(" ");
}

const SHELL_HTML =
  '<html><head><title>App</title></head><body><div id="root"></div>' +
  '<script defer src="/assets/app.js"></script></body></html>';
const RENDERED_HTML =
  `<html><head><title>Rendered docs</title></head><body><h1>Docs</h1>` +
  `<p>${words(80)}</p></body></html>`;

function htmlFetch(html: string, init?: { status?: number; type?: string }) {
  return vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(html, {
        status: init?.status ?? 200,
        headers: { "content-type": init?.type ?? "text/html" },
      }),
  );
}

describe("detectSpaShell", () => {
  it("does not flag an empty document", () => {
    expect(detectSpaShell("", PAGE_URL)).toBe(false);
  });

  it("flags a mount element with no server-rendered text", () => {
    expect(detectSpaShell(SHELL_HTML, PAGE_URL)).toBe(true);
  });

  it("flags a head-only document that loads a script bundle", () => {
    const html =
      '<html><head><title>Loading</title><script defer src="/app.js"></script></head></html>';
    expect(detectSpaShell(html, PAGE_URL)).toBe(true);
  });

  it("flags a sparse body with no headings but an external script bundle", () => {
    const html =
      '<html><body><script defer src="/bundle.js"></script></body></html>';
    expect(detectSpaShell(html, PAGE_URL)).toBe(true);
  });

  it("keeps a filled SSR page that retains its mount element", () => {
    const html = `<html><body><div id="root"><h1>Docs</h1><p>${words(80)}</p></div></body></html>`;
    expect(detectSpaShell(html, PAGE_URL)).toBe(false);
  });

  it("keeps a sparse page that already ships headings", () => {
    const html =
      "<html><body><h1>Welcome</h1><p>Short intro.</p>" +
      '<script defer src="/bundle.js"></script></body></html>';
    expect(detectSpaShell(html, PAGE_URL)).toBe(false);
  });

  it("keeps a sparse page with no mount element and no script bundle", () => {
    const html =
      '<html><body><div class="spinner"></div><script>window.x = 1</script></body></html>';
    expect(detectSpaShell(html, PAGE_URL)).toBe(false);
  });

  it("ignores a data: script src, which is no bundle to execute", () => {
    const html =
      '<html><body><script src="data:text/javascript,window.x=1"></script></body></html>';
    expect(detectSpaShell(html, PAGE_URL)).toBe(false);
  });
});

describe("resolvePageContent", () => {
  it("uses the raw body without probing when it is not a shell", async () => {
    const fetchMock = vi.fn();

    const result = await resolvePageContent({
      url: PAGE_URL,
      rawHtml: RENDERED_HTML,
      fetch: fetchMock,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      html: RENDERED_HTML,
      rendered: "raw",
      spaShell: false,
    });
  });

  it("adopts a rendered Googlebot body when the raw body is a shell", async () => {
    const fetchMock = htmlFetch(RENDERED_HTML);

    const result = await resolvePageContent({
      url: PAGE_URL,
      rawHtml: SHELL_HTML,
      fetch: fetchMock,
    });

    expect(result).toEqual({
      html: RENDERED_HTML,
      rendered: "googlebot",
      spaShell: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [probeUrl, probeInit] = fetchMock.mock.calls[0];
    expect(probeUrl).toBe(PAGE_URL);
    expect(new Headers(probeInit?.headers).get("user-agent")).toBe(
      GOOGLEBOT_UA,
    );
    expect(probeInit?.redirect).toBe("manual");
    expect(probeInit?.signal).toBeInstanceOf(AbortSignal);
  });

  it("keeps the shell verdict when Googlebot sees the same shell", async () => {
    const fetchMock = htmlFetch(SHELL_HTML);

    const result = await resolvePageContent({
      url: PAGE_URL,
      rawHtml: SHELL_HTML,
      fetch: fetchMock,
    });

    expect(result).toEqual({
      html: SHELL_HTML,
      rendered: "raw",
      spaShell: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("adopts a richer Googlebot shell that carries substantially more text", async () => {
    // Sparse enough to still read as a shell, but 40 words the raw body
    // lacked — more than the adoption threshold, so the probe wins.
    const richerShell =
      `<html><body><div id="root"><p>${words(40)}</p></div>` +
      '<script defer src="/app.js"></script></body></html>';
    const fetchMock = htmlFetch(richerShell);

    const result = await resolvePageContent({
      url: PAGE_URL,
      rawHtml: SHELL_HTML,
      fetch: fetchMock,
    });

    expect(result).toEqual({
      html: richerShell,
      rendered: "googlebot",
      spaShell: true,
    });
  });

  it("keeps the raw shell when the probe fails", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("network down");
    });

    const result = await resolvePageContent({
      url: PAGE_URL,
      rawHtml: SHELL_HTML,
      fetch: fetchMock,
    });

    expect(result).toEqual({
      html: SHELL_HTML,
      rendered: "raw",
      spaShell: true,
    });
  });

  it("keeps the raw shell when the probe is not an HTML 200", async () => {
    const blocked = htmlFetch("blocked", { status: 403 });
    const notHtml = htmlFetch('{"ok":true}', { type: "application/json" });

    const blockedResult = await resolvePageContent({
      url: PAGE_URL,
      rawHtml: SHELL_HTML,
      fetch: blocked,
    });
    const notHtmlResult = await resolvePageContent({
      url: PAGE_URL,
      rawHtml: SHELL_HTML,
      fetch: notHtml,
    });

    expect(blockedResult).toEqual({
      html: SHELL_HTML,
      rendered: "raw",
      spaShell: true,
    });
    expect(notHtmlResult).toEqual({
      html: SHELL_HTML,
      rendered: "raw",
      spaShell: true,
    });
  });

  it("keeps the raw shell when the probe returns an empty body", async () => {
    const fetchMock = htmlFetch("");

    const result = await resolvePageContent({
      url: PAGE_URL,
      rawHtml: SHELL_HTML,
      fetch: fetchMock,
    });

    expect(result).toEqual({
      html: SHELL_HTML,
      rendered: "raw",
      spaShell: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("bounds the probe at the thirty second page-fetch timeout", async () => {
    expect(PAGE_FETCH_TIMEOUT_MS).toBe(30_000);
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchMock = htmlFetch(RENDERED_HTML);

    await resolvePageContent({
      url: PAGE_URL,
      rawHtml: SHELL_HTML,
      fetch: fetchMock,
    });

    expect(timeoutSpy).toHaveBeenCalledWith(30_000);
    timeoutSpy.mockRestore();
  });
});
