import { beforeEach, describe, expect, it, vi } from "vitest";
import { getContentQualityTool } from "./get-content-quality";
import { makeToolContext, textContent } from "./tool-test-support";

const mocks = vi.hoisted(() => ({
  getProjectForOrganization: vi.fn(),
  gradeUrl: vi.fn(),
}));

vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    getProjectForOrganization: mocks.getProjectForOrganization,
  },
}));

vi.mock("@/server/auth/repositories/AuthRepository", () => ({
  AuthRepository: { getMembership: vi.fn() },
}));

vi.mock("@/server/features/audit/services/ContentQualityService", () => ({
  ContentQualityService: {
    gradeUrl: mocks.gradeUrl,
  },
}));

const toolContext = makeToolContext();

const GRADE_RESULT = {
  url: "https://example.com/products/tote",
  finalUrl: "https://example.com/products/tote",
  overall: 78,
  dimensions: {
    trust: 80,
    experience: 75,
    expertise: 70,
    authority: 65,
    readability: 82,
    originality: 90,
    thinness: 85,
  },
  findings: [{ code: "thin-intro", message: "Intro is thin." }],
  readingEase: 68,
  readingGrade: 8,
  topTerm: "tote",
  topTermDensity: 0.04,
  overOptimized: false,
  descriptionRestatesTitle: false,
  placeholders: [],
  stockCtas: [],
};

describe("get_content_quality MCP tool", () => {
  beforeEach(() => {
    mocks.getProjectForOrganization.mockResolvedValue({
      id: "project_1",
      locationCode: 2840,
      languageCode: "en",
    });
    mocks.gradeUrl.mockResolvedValue(GRADE_RESULT);
  });

  it("delegates to ContentQualityService and returns the grade", async () => {
    const result = await getContentQualityTool.handler(
      { projectId: "project_1", url: "https://example.com/products/tote" },
      toolContext,
    );

    expect(mocks.gradeUrl).toHaveBeenCalledWith({
      projectId: "project_1",
      url: "https://example.com/products/tote",
    });
    expect(result.structuredContent).toMatchObject({
      grade: {
        finalUrl: "https://example.com/products/tote",
        overall: 78,
        findingCount: 1,
      },
    });
  });

  it("summarizes the grade in the text response", async () => {
    const result = await getContentQualityTool.handler(
      { projectId: "project_1", url: "https://example.com/products/tote" },
      toolContext,
    );

    expect(textContent(result)).toContain("78/100");
  });
});
