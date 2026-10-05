import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureDriftBaselineTool,
  compareDriftBaselineTool,
  getDriftChangesTool,
} from "./drift-tools";
import { makeToolContext, textContent } from "./tool-test-support";

const mocks = vi.hoisted(() => ({
  getProjectForOrganization: vi.fn(),
  captureBaseline: vi.fn(),
  compareBaseline: vi.fn(),
  getChanges: vi.fn(),
}));

vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    getProjectForOrganization: mocks.getProjectForOrganization,
  },
}));

vi.mock("@/server/auth/repositories/AuthRepository", () => ({
  AuthRepository: { getMembership: vi.fn() },
}));

vi.mock("@/server/features/drift/services/DriftService", () => ({
  DriftService: {
    captureBaseline: mocks.captureBaseline,
    compareBaseline: mocks.compareBaseline,
    getChanges: mocks.getChanges,
  },
}));

const toolContext = makeToolContext();

describe("drift MCP tools", () => {
  beforeEach(() => {
    mocks.getProjectForOrganization.mockResolvedValue({
      id: "project_1",
      locationCode: 2840,
      languageCode: "en",
    });
  });

  it("captures a baseline through capture_drift_baseline", async () => {
    mocks.captureBaseline.mockResolvedValue({
      baseline: { id: "baseline_1", projectId: "project_1", name: "Weekly" },
      snapshots: [{ url: "https://example.com/a" }],
      failures: [],
    });

    const result = await captureDriftBaselineTool.handler(
      { projectId: "project_1", urls: ["https://example.com/a"] },
      toolContext,
    );

    expect(mocks.captureBaseline).toHaveBeenCalledWith({
      projectId: "project_1",
      urls: ["https://example.com/a"],
      name: undefined,
    });
    expect(result.structuredContent).toMatchObject({
      baselineId: "baseline_1",
      captured: 1,
      failures: 0,
    });
  });

  it("compares through compare_drift", async () => {
    mocks.compareBaseline.mockResolvedValue({
      baselineId: "baseline_1",
      compared: 10,
      failures: [],
      inserted: 2,
      resolved: 1,
      kept: 0,
      severityCounts: {},
    });

    const result = await compareDriftBaselineTool.handler(
      { projectId: "project_1", baselineId: "baseline_1" },
      toolContext,
    );

    expect(result.structuredContent).toMatchObject({
      compared: 10,
      inserted: 2,
      resolved: 1,
    });
    expect(textContent(result)).toContain("2 new change(s)");
  });

  it("reads changes through get_drift_changes", async () => {
    mocks.getChanges.mockResolvedValue([
      {
        url: "https://example.com/a",
        field: "title",
        severity: "warning",
        oldValue: "Old",
        newValue: "New",
        resolvedAt: null,
      },
    ]);

    const result = await getDriftChangesTool.handler(
      { projectId: "project_1", baselineId: "baseline_1" },
      toolContext,
    );

    expect(result.structuredContent).toMatchObject({ changeCount: 1 });
    expect(textContent(result)).toContain("1 still open");
  });
});
