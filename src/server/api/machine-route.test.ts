import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { machineGet, machinePost } from "./machine-route";

const mocks = vi.hoisted(() => ({
  verifyApiKey: vi.fn(),
  getHostedUser: vi.fn(),
  resolveExistingActiveHostedOrganization: vi.fn(),
  getProjectForOrganization: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  getAuth: () => ({
    api: { verifyApiKey: mocks.verifyApiKey },
  }),
}));

vi.mock("@/server/auth/repositories/AuthRepository", () => ({
  AuthRepository: { getHostedUser: mocks.getHostedUser },
}));

vi.mock("@/server/auth/default-hosted-organization", () => ({
  resolveExistingActiveHostedOrganization:
    mocks.resolveExistingActiveHostedOrganization,
}));

vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    getProjectForOrganization: mocks.getProjectForOrganization,
  },
}));

const schema = z.object({ projectId: z.string(), url: z.string() });

function postRequest(body: unknown, headers?: Record<string, string>) {
  return new Request("https://app.openseo.so/api/v1/page-audit", {
    method: "POST",
    headers: { "x-api-key": "oseo_testkey", ...headers },
    body: JSON.stringify(body),
  });
}

describe("machinePost", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.verifyApiKey.mockResolvedValue({
      valid: true,
      key: { referenceId: "user-1" },
      error: null,
    });
    mocks.getHostedUser.mockResolvedValue({
      id: "user-1",
      email: "person@example.com",
    });
    mocks.resolveExistingActiveHostedOrganization.mockResolvedValue({
      organizationId: "org-1",
      role: "owner",
    });
    mocks.getProjectForOrganization.mockResolvedValue({ id: "project-1" });
  });

  it("authenticates, validates, and returns handler output", async () => {
    const response = await machinePost(
      postRequest({ projectId: "project-1", url: "https://example.com/" }),
      schema,
      async (auth, input) => ({ ok: true, project: auth.projectId, input }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      project: "project-1",
    });
  });

  it("returns 401 without a key and 400 for bad bodies", async () => {
    const noKey = await machinePost(
      new Request("https://app.openseo.so/api/v1/page-audit", {
        method: "POST",
        body: JSON.stringify({ projectId: "project-1", url: "x" }),
      }),
      schema,
      async () => ({}),
    );
    expect(noKey.status).toBe(401);

    const badBody = await machinePost(
      postRequest({ projectId: "project-1" }),
      schema,
      async () => ({}),
    );
    expect(badBody.status).toBe(400);
    expect(await badBody.json()).toMatchObject({ error: "invalid_request" });
  });
});

describe("machineGet", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.verifyApiKey.mockResolvedValue({
      valid: true,
      key: { referenceId: "user-1" },
      error: null,
    });
    mocks.getHostedUser.mockResolvedValue({
      id: "user-1",
      email: "person@example.com",
    });
    mocks.resolveExistingActiveHostedOrganization.mockResolvedValue({
      organizationId: "org-1",
      role: "owner",
    });
    mocks.getProjectForOrganization.mockResolvedValue({ id: "project-1" });
  });

  it("reads projectId from the query string", async () => {
    const response = await machineGet(
      new Request(
        "https://app.openseo.so/api/v1/drift/changes?projectId=project-1&baselineId=b1",
        { headers: { "x-api-key": "oseo_testkey" } },
      ),
      async (auth, url) => ({
        project: auth.projectId,
        baseline: url.searchParams.get("baselineId"),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      project: "project-1",
      baseline: "b1",
    });
  });
});
