import { describe, expect, it } from "vitest";
import {
  CRUX_HISTORY_ENDPOINT,
  CRUX_RECORD_ENDPOINT,
  GooglePageSpeedService,
  PSI_ENDPOINT,
  type GoogleApiCallOptions,
} from "./googlePageSpeedClient";

const _optionsCheck: GoogleApiCallOptions = { apiKey: "key" };
void _optionsCheck;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

function errorResponse(status: number, text: string): Response {
  return new Response(text, { status });
}

function urlText(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

describe("GooglePageSpeedService", () => {
  it("fetches PSI with strategy and categories", async () => {
    const seen: Array<{ url: string }> = [];
    const fetchImpl: typeof fetch = async (input) => {
      seen.push({ url: urlText(input) });
      return jsonResponse(200, { lighthouseResult: {} });
    };
    await GooglePageSpeedService.fetchPsi("https://example.com/", {
      strategy: "desktop",
      fetchImpl,
    });
    const url = seen[0]?.url ?? "";
    expect(url.startsWith(PSI_ENDPOINT)).toBe(true);
    expect(url).toContain("strategy=DESKTOP");
    expect(url).toContain("category=PERFORMANCE");
  });

  it("maps PSI rate limits and bad requests", async () => {
    const limited: typeof fetch = async () => jsonResponse(429, {});
    await expect(
      GooglePageSpeedService.fetchPsi("https://example.com/", {
        fetchImpl: limited,
      }),
    ).rejects.toThrow("rate limit");
    const bad: typeof fetch = async () => errorResponse(400, "bad url");
    await expect(
      GooglePageSpeedService.fetchPsi("https://example.com/", {
        fetchImpl: bad,
      }),
    ).rejects.toThrow("Invalid URL");
    await expect(
      GooglePageSpeedService.fetchPsi("not-a-url", { fetchImpl: bad }),
    ).rejects.toThrow("Invalid URL");
  });

  it("requires a key for CrUX and maps 404 to ineligibility", async () => {
    const unused: typeof fetch = async () => jsonResponse(200, {});
    await expect(
      GooglePageSpeedService.queryCruxRecord("https://example.com/", {
        apiKey: undefined,
        fetchImpl: unused,
      }),
    ).rejects.toThrow("requires an API key");
    const seen: Array<{ url: string }> = [];
    const missing: typeof fetch = async (input) => {
      seen.push({ url: urlText(input) });
      return jsonResponse(404, {});
    };
    await expect(
      GooglePageSpeedService.queryCruxRecord("https://example.com/", {
        apiKey: "key",
        fetchImpl: missing,
      }),
    ).rejects.toThrow("insufficient Chrome traffic");
    expect((seen[0]?.url ?? "").startsWith(CRUX_RECORD_ENDPOINT)).toBe(true);
  });

  it("posts form factor to the history endpoint", async () => {
    const seen: Array<{ url: string; body: unknown }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      seen.push({ url: urlText(input), body: init?.body });
      return jsonResponse(200, { record: {} });
    };
    await GooglePageSpeedService.queryCruxHistory("https://example.com/", {
      apiKey: "key",
      formFactor: "phone",
      fetchImpl,
    });
    const call = seen[0];
    const url = call?.url ?? "";
    expect(url.startsWith(CRUX_HISTORY_ENDPOINT)).toBe(true);
    expect(url).toContain("key=key");
    const body = call?.body;
    expect(typeof body === "string" ? JSON.parse(body) : {}).toMatchObject({
      url: "https://example.com/",
      formFactor: "PHONE",
    });
  });
});
