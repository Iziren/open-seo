import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type * as DriftRepositoryModule from "./DriftRepository";

// Real in-memory SQLite for the change-row lifecycle: reconciliation reads
// only unresolved rows, resolve stamps them in place, and every read stays
// project-scoped through the baseline join. (Snapshot reads live in
// DriftRepository.query.test.ts.)

vi.mock("cloudflare:workers", () => ({ env: { DATABASE_PROVIDER: "d1" } }));

let client: Client;
let DriftRepository: typeof DriftRepositoryModule.DriftRepository;

beforeAll(async () => {
  client = createClient({ url: "file::memory:" });
  const testDb = drizzle(client);
  vi.doMock("@/db", () => ({ db: testDb }));
  vi.doMock("@/db/d1/client", () => ({ d1Db: testDb }));
  vi.doMock("@/db/pg/client", () => ({ pgDb: null }));

  await client.executeMultiple(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE seo_drift_baselines (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE seo_drift_changes (
      id TEXT PRIMARY KEY,
      baseline_id TEXT NOT NULL,
      url TEXT NOT NULL,
      field TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      change_type TEXT NOT NULL,
      severity TEXT NOT NULL,
      detected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      resolved_at TEXT
    );
  `);

  ({ DriftRepository } = await import("./DriftRepository"));
});

afterAll(() => {
  client.close();
});

beforeEach(async () => {
  await client.executeMultiple(`
    DELETE FROM seo_drift_changes;
    DELETE FROM seo_drift_baselines;
    DELETE FROM projects;
  `);
});

async function seedProject(id: string) {
  await client.execute({
    sql: "INSERT INTO projects (id, organization_id, name) VALUES (?, ?, ?)",
    args: [id, `org_${id}`, id],
  });
}

async function seedBaseline(id: string, projectId: string) {
  await client.execute({
    sql: "INSERT INTO seo_drift_baselines (id, project_id, name) VALUES (?, ?, ?)",
    args: [id, projectId, id],
  });
}

function changeRow(input: {
  id: string;
  baselineId: string;
  url: string;
  field: string;
  detectedAt: string;
  resolvedAt?: string | null;
}) {
  return {
    id: input.id,
    baselineId: input.baselineId,
    url: input.url,
    field: input.field,
    oldValue: "before",
    newValue: "after",
    changeType: "changed" as const,
    severity: "warning" as const,
    detectedAt: input.detectedAt,
    resolvedAt: input.resolvedAt ?? null,
  };
}

describe("getOpenChanges / resolveChanges", () => {
  it("lists only unresolved rows for the baseline, ordered by url and field", async () => {
    await seedProject("proj_1");
    await seedBaseline("base_1", "proj_1");
    await seedProject("proj_other");
    await seedBaseline("base_other", "proj_other");

    await DriftRepository.insertChanges([
      changeRow({
        id: "chg_z",
        baselineId: "base_1",
        url: "https://example.com/z",
        field: "title",
        detectedAt: "2026-09-23T00:00:00.000Z",
      }),
      changeRow({
        id: "chg_a",
        baselineId: "base_1",
        url: "https://example.com/a",
        field: "h1",
        detectedAt: "2026-09-23T00:00:00.000Z",
      }),
      changeRow({
        id: "chg_done",
        baselineId: "base_1",
        url: "https://example.com/m",
        field: "title",
        detectedAt: "2026-09-22T00:00:00.000Z",
        resolvedAt: "2026-09-24T00:00:00.000Z",
      }),
      changeRow({
        id: "chg_other",
        baselineId: "base_other",
        url: "https://example.com/a",
        field: "title",
        detectedAt: "2026-09-23T00:00:00.000Z",
      }),
    ]);

    const open = await DriftRepository.getOpenChanges("base_1");
    expect(open.map((row) => row.id)).toEqual(["chg_a", "chg_z"]);
    // Reconciliation only needs the compared fields, so the projection stays
    // minimal: severity lives on the change-history reads.
    expect(open[0]).toMatchObject({
      url: "https://example.com/a",
      field: "h1",
      oldValue: "before",
      newValue: "after",
      changeType: "changed",
    });
  });

  it("resolves the given ids and ignores unknown or empty id lists", async () => {
    await seedProject("proj_1");
    await seedBaseline("base_1", "proj_1");
    await DriftRepository.insertChanges([
      changeRow({
        id: "chg_1",
        baselineId: "base_1",
        url: "https://example.com/a",
        field: "title",
        detectedAt: "2026-09-23T00:00:00.000Z",
      }),
      changeRow({
        id: "chg_2",
        baselineId: "base_1",
        url: "https://example.com/b",
        field: "title",
        detectedAt: "2026-09-23T00:00:00.000Z",
      }),
    ]);

    await DriftRepository.resolveChanges([], "2026-09-24T00:00:00.000Z");
    await DriftRepository.resolveChanges(
      ["chg_1", "chg_unknown"],
      "2026-09-24T00:00:00.000Z",
    );

    expect(
      (await DriftRepository.getOpenChanges("base_1")).map((row) => row.id),
    ).toEqual(["chg_2"]);
  });
});

describe("getChangesForUrl", () => {
  it("returns project-scoped change history newest first, resolved included", async () => {
    await seedProject("proj_1");
    await seedProject("proj_other");
    await seedBaseline("base_1", "proj_1");
    await seedBaseline("base_2", "proj_1");
    await seedBaseline("base_other", "proj_other");

    await DriftRepository.insertChanges([
      changeRow({
        id: "chg_old",
        baselineId: "base_1",
        url: "https://example.com/page",
        field: "title",
        detectedAt: "2026-09-20T00:00:00.000Z",
        resolvedAt: "2026-09-21T00:00:00.000Z",
      }),
      changeRow({
        id: "chg_new",
        baselineId: "base_2",
        url: "https://example.com/page",
        field: "title",
        detectedAt: "2026-09-27T00:00:00.000Z",
      }),
      changeRow({
        id: "chg_other_project",
        baselineId: "base_other",
        url: "https://example.com/page",
        field: "title",
        detectedAt: "2026-09-28T00:00:00.000Z",
      }),
    ]);

    const changes = await DriftRepository.getChangesForUrl({
      projectId: "proj_1",
      url: "https://example.com/page",
      limit: 5,
    });
    expect(changes.map((row) => row.id)).toEqual(["chg_new", "chg_old"]);
    expect(changes[1].resolvedAt).toBe("2026-09-21T00:00:00.000Z");
  });
});

describe("getChangesForBaseline", () => {
  it("returns the baseline's changes newest first", async () => {
    await seedProject("proj_1");
    await seedBaseline("base_1", "proj_1");

    await DriftRepository.insertChanges([
      changeRow({
        id: "chg_b",
        baselineId: "base_1",
        url: "https://example.com/page",
        field: "meta_description",
        detectedAt: "2026-09-23T01:00:00.000Z",
      }),
      changeRow({
        id: "chg_a",
        baselineId: "base_1",
        url: "https://example.com/page",
        field: "h1",
        detectedAt: "2026-09-23T00:00:00.000Z",
      }),
    ]);

    const changes = await DriftRepository.getChangesForBaseline({
      projectId: "proj_1",
      baselineId: "base_1",
      limit: 5,
    });
    expect(changes.map((row) => row.id)).toEqual(["chg_b", "chg_a"]);
  });
});
