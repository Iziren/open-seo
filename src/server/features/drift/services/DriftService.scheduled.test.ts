import { describe, expect, it, vi } from "vitest";
import { DriftService } from "./DriftService";

// Repository is mocked; the scheduled comparison exercises the real
// compareBaseline orchestration against mocked rows (no fetch: the
// fixtures carry empty snapshot lists).

const mocks = vi.hoisted(() => ({
  getBaseline: vi.fn(),
  getSnapshotsForBaseline: vi.fn(),
  getOpenChanges: vi.fn(),
  insertChanges: vi.fn(),
  resolveChanges: vi.fn(),
  touchBaselineCompared: vi.fn(),
  listBaselines: vi.fn(),
  getDueBaselines: vi.fn(),
}));

vi.mock("../repositories/DriftRepository", () => ({
  DriftRepository: mocks,
}));

describe("DriftService.listBaselines", () => {
  it("delegates project scoping to the repository", async () => {
    mocks.listBaselines.mockResolvedValue([{ id: "base_1" }]);

    await expect(
      DriftService.listBaselines({ projectId: "proj_1" }),
    ).resolves.toEqual([{ id: "base_1" }]);
    expect(mocks.listBaselines).toHaveBeenCalledWith({
      projectId: "proj_1",
    });
  });
});

describe("DriftService.runScheduledComparisons", () => {
  it("compares due baselines and isolates failures", async () => {
    mocks.getDueBaselines.mockResolvedValue([
      { id: "ok", projectId: "proj_1" },
      { id: "bad", projectId: "proj_1" },
    ]);
    mocks.getBaseline.mockImplementation(
      async (input: { baselineId: string; projectId: string }) => {
        if (input.baselineId === "bad") throw new Error("db down");
        return { id: input.baselineId, projectId: input.projectId };
      },
    );
    mocks.getSnapshotsForBaseline.mockResolvedValue([]);
    mocks.getOpenChanges.mockResolvedValue([]);

    await expect(DriftService.runScheduledComparisons()).resolves.toEqual({
      compared: 1,
      failed: 1,
    });
    expect(mocks.touchBaselineCompared).toHaveBeenCalledWith(
      expect.objectContaining({ baselineId: "ok" }),
    );
  });

  it("compares nothing when nothing is due", async () => {
    mocks.getDueBaselines.mockResolvedValue([]);

    await expect(DriftService.runScheduledComparisons()).resolves.toEqual({
      compared: 0,
      failed: 0,
    });
  });
});
