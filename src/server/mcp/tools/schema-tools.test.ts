import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateSchemaTool } from "./generate-schema";
import { getSchemaTool } from "./get-schema";
import { makeToolContext, textContent } from "./tool-test-support";

const mocks = vi.hoisted(() => ({
  getProjectForOrganization: vi.fn(),
  generate: vi.fn(),
  extractFromUrl: vi.fn(),
}));

vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    getProjectForOrganization: mocks.getProjectForOrganization,
  },
}));

vi.mock("@/server/auth/repositories/AuthRepository", () => ({
  AuthRepository: { getMembership: vi.fn() },
}));

vi.mock("@/server/features/audit/services/SchemaService", () => ({
  SchemaService: {
    generate: mocks.generate,
    extractFromUrl: mocks.extractFromUrl,
  },
}));

const toolContext = makeToolContext();

describe("schema MCP tools", () => {
  beforeEach(() => {
    mocks.getProjectForOrganization.mockResolvedValue({
      id: "project_1",
      locationCode: 2840,
      languageCode: "en",
    });
  });

  it("generates schema through generate_schema", async () => {
    mocks.generate.mockResolvedValue({
      type: "Product",
      document: { "@graph": [] },
      script: '{"@graph":[]}',
      validation: { ok: true, errors: [], warnings: [], recommendations: [] },
    });

    const result = await generateSchemaTool.handler(
      {
        projectId: "project_1",
        type: "Product",
        data: { name: "Canvas Tote" },
      },
      toolContext,
    );

    expect(mocks.generate).toHaveBeenCalledWith({
      projectId: "project_1",
      type: "Product",
      data: { name: "Canvas Tote" },
    });
    expect(result.structuredContent).toMatchObject({
      type: "Product",
      valid: true,
    });
    expect(textContent(result)).toContain("validates clean");
  });

  it("reads page schema through get_schema", async () => {
    mocks.extractFromUrl.mockResolvedValue({
      url: "https://example.com/products/tote",
      finalUrl: "https://example.com/products/tote",
      types: ["Product"],
      scriptCount: 1,
      validation: { ok: true, errors: [], warnings: [], recommendations: [] },
    });

    const result = await getSchemaTool.handler(
      { projectId: "project_1", url: "https://example.com/products/tote" },
      toolContext,
    );

    expect(mocks.extractFromUrl).toHaveBeenCalledWith({
      projectId: "project_1",
      url: "https://example.com/products/tote",
    });
    expect(result.structuredContent).toMatchObject({
      types: ["Product"],
      valid: true,
    });
  });
});
