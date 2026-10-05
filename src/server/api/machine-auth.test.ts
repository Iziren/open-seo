import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/server/lib/errors";
import {
  requireMachineOrgAccess,
  requireMachineProjectAccess,
  toMachineErrorResponse,
} from "./machine-auth";

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

function request(headers?: HeadersInit) {
  return new Request("https://app.openseo.so/api/v1/page-audit", {
    method: "POST",
    headers,
  });
}

describe("requireMachineProjectAccess", () => {
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

  it("resolves org + project context for a valid key", async () => {
    const auth = await requireMachineProjectAccess(
      request({ "x-api-key": "oseo_testkey" }),
      "project-1",
    );

    expect(auth.organizationId).toBe("org-1");
    expect(auth.projectId).toBe("project-1");
    expect(auth.billingCustomer).toMatchObject({
      organizationId: "org-1",
      userId: "user-1",
      projectId: "project-1",
    });
    expect(mocks.getProjectForOrganization).toHaveBeenCalledWith(
      "org-1",
      "project-1",
    );
  });

  it("accepts a Bearer key", async () => {
    const auth = await requireMachineProjectAccess(
      request({ Authorization: "Bearer oseo_testkey" }),
      "project-1",
    );
    expect(auth.userId).toBe("user-1");
  });

  it("rejects missing and foreign keys before any lookup", async () => {
    await expect(
      requireMachineProjectAccess(request(), "project-1"),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(
      requireMachineProjectAccess(
        request({ "x-api-key": "sk-something-else" }),
        "project-1",
      ),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(mocks.verifyApiKey).not.toHaveBeenCalled();
  });

  it("rejects invalid keys and foreign projects", async () => {
    mocks.verifyApiKey.mockResolvedValue({
      valid: false,
      key: null,
      error: null,
    });
    await expect(
      requireMachineProjectAccess(
        request({ "x-api-key": "oseo_bad" }),
        "project-1",
      ),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });

    mocks.verifyApiKey.mockResolvedValue({
      valid: true,
      key: { referenceId: "user-1" },
      error: null,
    });
    mocks.getProjectForOrganization.mockResolvedValue(null);
    await expect(
      requireMachineProjectAccess(
        request({ "x-api-key": "oseo_testkey" }),
        "project-other-org",
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects keys with no organization", async () => {
    mocks.resolveExistingActiveHostedOrganization.mockResolvedValue(null);
    await expect(
      requireMachineProjectAccess(
        request({ "x-api-key": "oseo_testkey" }),
        "project-1",
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("requireMachineOrgAccess", () => {
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
  });

  it("resolves org context without a project", async () => {
    const auth = await requireMachineOrgAccess(
      request({ "x-api-key": "oseo_testkey" }),
    );
    expect(auth.organizationId).toBe("org-1");
    expect(mocks.getProjectForOrganization).not.toHaveBeenCalled();
  });
});

describe("toMachineErrorResponse", () => {
  it("maps AppError codes to HTTP statuses", async () => {
    const cases: Array<[AppError, number, string]> = [
      [new AppError("UNAUTHENTICATED", "x"), 401, "invalid_api_key"],
      [new AppError("FORBIDDEN", "x"), 403, "forbidden"],
      [new AppError("NOT_FOUND", "x"), 404, "not_found"],
      [new AppError("VALIDATION_ERROR", "x"), 400, "invalid_request"],
      [new AppError("CONFLICT", "x"), 409, "conflict"],
      [new AppError("INSUFFICIENT_CREDITS", "x"), 402, "usage_exceeded"],
      [new AppError("SPEND_CAP_EXCEEDED", "x"), 402, "usage_exceeded"],
      [new AppError("RATE_LIMITED", "x"), 429, "rate_limited"],
    ];
    for (const [error, status, code] of cases) {
      const response = toMachineErrorResponse(error);
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ error: code });
    }
  });

  it("masks unknown errors as 500", async () => {
    const response = toMachineErrorResponse(new Error("boom"));
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: "internal_error" });
  });
});
