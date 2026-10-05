import { beforeEach, describe, expect, it, vi } from "vitest";
import { getPageAuditTool } from "./get-page-audit";
import { makeToolContext, textContent } from "./tool-test-support";

const mocks = vi.hoisted(() => ({
  getProjectForOrganization: vi.fn(),
  auditPage: vi.fn(),
}));

vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    getProjectForOrganization: mocks.getProjectForOrganization,
  },
}));

vi.mock("@/server/auth/repositories/AuthRepository", () => ({
  AuthRepository: { getMembership: vi.fn() },
}));

vi.mock("@/server/features/audit/services/PageAuditService", () => ({
  PageAuditService: {
    auditPage: mocks.auditPage,
  },
}));

const toolContext = makeToolContext();

const PAGE_RESULT = {
  url: "https://example.com/products/tote",
  finalUrl: "https://example.com/products/tote",
  statusCode: 200,
  responseTimeMs: 320,
  title: "Canvas Tote",
  metaDescription: "A sturdy tote.",
  wordCount: 412,
  h1Count: 1,
  imagesTotal: 3,
  imagesMissingAlt: 0,
  isIndexable: true,
  spaShell: false,
  contentScore: 82,
  contentFindings: [],
  schemaStatus: "missing" as const,
  schemaTypes: [],
  geoScore: 74,
  issues: [
    {
      issueType: "missing-meta-description" as const,
      pageId: null,
      pageUrl: "https://example.com/products/tote",
    },
  ],
};

describe("get_page_audit MCP tool", () => {
  beforeEach(() => {
    mocks.getProjectForOrganization.mockResolvedValue({
      id: "project_1",
      locationCode: 2840,
      languageCode: "en",
    });
    mocks.auditPage.mockResolvedValue(PAGE_RESULT);
  });

  it("delegates to PageAuditService and returns the report card", async () => {
    const result = await getPageAuditTool.handler(
      { projectId: "project_1", url: "https://example.com/products/tote" },
      toolContext,
    );

    expect(mocks.auditPage).toHaveBeenCalledWith({
      projectId: "project_1",
      url: "https://example.com/products/tote",
    });
    expect(result.structuredContent).toMatchObject({
      page: {
        finalUrl: "https://example.com/products/tote",
        contentScore: 82,
        schemaStatus: "missing",
        geoScore: 74,
        issueCount: 1,
      },
    });
  });

  it("summarizes top issues in the text response", async () => {
    const result = await getPageAuditTool.handler(
      { projectId: "project_1", url: "https://example.com/products/tote" },
      toolContext,
    );

    const text = textContent(result);
    expect(text).toContain("82/100");
    expect(text).toContain("missing-meta-description");
  });
});
