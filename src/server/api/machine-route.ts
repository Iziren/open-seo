import { z } from "zod";
import {
  requireMachineOrgAccess,
  requireMachineProjectAccess,
  toMachineErrorResponse,
  type MachineAuthContext,
  type MachineOrgContext,
} from "./machine-auth";
import { AppError } from "@/server/lib/errors";

/**
 * Shared handler shell for the /api/v1 machine surface: JSON body parsed
 * and Zod-validated, `oseo_` key verified, projectId gated to the key's
 * organization, AppErrors mapped to HTTP statuses. Every machine endpoint
 * requires projectId (in the body for POST) so keys stay project-scoped.
 */
export async function machinePost<TInput extends { projectId: string }>(
  request: Request,
  schema: z.ZodType<TInput>,
  run: (auth: MachineAuthContext, input: TInput) => Promise<unknown>,
): Promise<Response> {
  try {
    const body: unknown = await request.json().catch(() => null);
    const parsed = schema.parse(body);
    const auth = await requireMachineProjectAccess(request, parsed.projectId);
    return Response.json(await run(auth, parsed));
  } catch (error) {
    if (error instanceof z.ZodError) {
      return toMachineErrorResponse(
        new AppError("VALIDATION_ERROR", "Invalid request body"),
      );
    }
    return toMachineErrorResponse(error);
  }
}

/** GET variant: projectId (plus resource ids) ride the query string. */
export async function machineGet(
  request: Request,
  run: (auth: MachineAuthContext, url: URL) => Promise<unknown>,
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const projectId = url.searchParams.get("projectId");
    if (!projectId) {
      throw new AppError("VALIDATION_ERROR", "projectId is required");
    }
    const auth = await requireMachineProjectAccess(request, projectId);
    return Response.json(await run(auth, url));
  } catch (error) {
    return toMachineErrorResponse(error);
  }
}

/** Org-scoped POST for endpoints that provision rather than name a project. */
export async function machineOrgPost<TInput>(
  request: Request,
  schema: z.ZodType<TInput>,
  run: (auth: MachineOrgContext, input: TInput) => Promise<unknown>,
): Promise<Response> {
  try {
    const body: unknown = await request.json().catch(() => null);
    const parsed = schema.parse(body);
    const auth = await requireMachineOrgAccess(request);
    return Response.json(await run(auth, parsed));
  } catch (error) {
    if (error instanceof z.ZodError) {
      return toMachineErrorResponse(
        new AppError("VALIDATION_ERROR", "Invalid request body"),
      );
    }
    return toMachineErrorResponse(error);
  }
}
