import { getAuth } from "@/lib/auth";
import { API_KEY_PREFIX } from "@/lib/auth-api-key";
import { AuthRepository } from "@/server/auth/repositories/AuthRepository";
import { resolveExistingActiveHostedOrganization } from "@/server/auth/default-hosted-organization";
import { ProjectService } from "@/server/features/projects/services/ProjectService";
import { AppError } from "@/server/lib/errors";
import type { BillingCustomerContext } from "@/server/billing/subscription";

export interface MachineAuthContext {
  userId: string;
  userEmail: string;
  organizationId: string;
  role: string;
  projectId: string;
  billingCustomer: BillingCustomerContext;
}

function getApiKey(request: Request): string | null {
  const headerKey = request.headers.get("x-api-key");
  if (headerKey?.startsWith(API_KEY_PREFIX)) return headerKey;

  const bearerToken = request.headers
    .get("Authorization")
    ?.replace(/^Bearer /i, "");
  if (bearerToken?.startsWith(API_KEY_PREFIX)) return bearerToken;

  return null;
}

function machineErrorResponse(
  code: string,
  description: string,
  status: number,
): Response {
  return Response.json(
    { error: code, error_description: description },
    { status },
  );
}

/**
 * Machine-to-machine auth for the /api/v1 REST surface. Mirrors the MCP
 * API-key flow (same `oseo_` keys, same Better Auth verification, same
 * fail-closed org resolution), then gates on the request's projectId so a
 * key can only reach projects in its organization. Throws AppError with
 * HTTP-mapped codes; route handlers convert via toMachineErrorResponse.
 */
export async function requireMachineProjectAccess(
  request: Request,
  projectId: string,
): Promise<MachineAuthContext> {
  const apiKey = getApiKey(request);
  if (!apiKey) {
    throw new AppError("UNAUTHENTICATED", "Missing API key");
  }

  const authApi = getAuth().api;
  const result = await authApi.verifyApiKey({ body: { key: apiKey } });
  if (!result.valid || !result.key) {
    throw new AppError("UNAUTHENTICATED", "Invalid API key");
  }

  const userId = result.key.referenceId;
  const user = await AuthRepository.getHostedUser(userId);
  if (!user?.email) {
    throw new AppError("FORBIDDEN", "API key has no hosting user");
  }

  const resolved = await resolveExistingActiveHostedOrganization(userId);
  if (!resolved) {
    throw new AppError(
      "FORBIDDEN",
      "API key is not associated with an organization",
    );
  }

  const project = await ProjectService.getProjectForOrganization(
    resolved.organizationId,
    projectId,
  );
  if (!project) {
    throw new AppError("FORBIDDEN", "Project not found in this organization");
  }

  return {
    userId,
    userEmail: user.email,
    organizationId: resolved.organizationId,
    role: resolved.role,
    projectId: project.id,
    billingCustomer: {
      organizationId: resolved.organizationId,
      userId,
      userEmail: user.email,
      projectId: project.id,
    },
  };
}

export interface MachineOrgContext {
  userId: string;
  userEmail: string;
  organizationId: string;
  role: string;
  billingCustomer: BillingCustomerContext;
}

/**
 * Org-level machine auth for endpoints that don't name a project (project
 * provisioning). Same key verification + fail-closed org resolution as the
 * project gate above.
 */
export async function requireMachineOrgAccess(
  request: Request,
): Promise<MachineOrgContext> {
  const apiKey = getApiKey(request);
  if (!apiKey) {
    throw new AppError("UNAUTHENTICATED", "Missing API key");
  }

  const authApi = getAuth().api;
  const result = await authApi.verifyApiKey({ body: { key: apiKey } });
  if (!result.valid || !result.key) {
    throw new AppError("UNAUTHENTICATED", "Invalid API key");
  }

  const userId = result.key.referenceId;
  const user = await AuthRepository.getHostedUser(userId);
  if (!user?.email) {
    throw new AppError("FORBIDDEN", "API key has no hosting user");
  }

  const resolved = await resolveExistingActiveHostedOrganization(userId);
  if (!resolved) {
    throw new AppError(
      "FORBIDDEN",
      "API key is not associated with an organization",
    );
  }

  return {
    userId,
    userEmail: user.email,
    organizationId: resolved.organizationId,
    role: resolved.role,
    billingCustomer: {
      organizationId: resolved.organizationId,
      userId,
      userEmail: user.email,
    },
  };
}
/** Map AppError codes to HTTP statuses for machine API responses. */
export function toMachineErrorResponse(error: unknown): Response {
  const code = error instanceof AppError ? error.code : "INTERNAL_ERROR";
  const message = error instanceof AppError ? error.message : "Internal error";
  switch (code) {
    case "UNAUTHENTICATED":
      return machineErrorResponse("invalid_api_key", message, 401);
    case "FORBIDDEN":
      return machineErrorResponse("forbidden", message, 403);
    case "NOT_FOUND":
      return machineErrorResponse("not_found", message, 404);
    case "VALIDATION_ERROR":
      return machineErrorResponse("invalid_request", message, 400);
    case "CONFLICT":
      return machineErrorResponse("conflict", message, 409);
    case "INSUFFICIENT_CREDITS":
    case "SPEND_CAP_EXCEEDED":
      return machineErrorResponse("usage_exceeded", message, 402);
    case "RATE_LIMITED":
      return machineErrorResponse("rate_limited", message, 429);
    default:
      console.error("[api-v1] unhandled error:", error);
      return machineErrorResponse("internal_error", "Internal error", 500);
  }
}
