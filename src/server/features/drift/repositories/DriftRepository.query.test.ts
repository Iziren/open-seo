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

// Real in-memory SQLite so the project-scoped joins, ordering, and the
// batched snapshot insert run against actual SQL — the parts a mocked
// builder chain can't see. (Change-row reads live in
// DriftRepository.changes.test.ts.)

vi.mock("cloudflare:workers", () => ({ env: { DATABASE_PROVIDER: "d1" } }));

let client: Client;
let DriftRepository: typeof DriftRepositoryModule.DriftRepository;

beforeAll(async () => {
  client = createClient({ url: "file::memory:" });
  const testDb = drizzle(client);
  // testDb only exists at runtime, so the module under test must load after
  // these mocks — the one sanctioned use of doMock + dynamic import.
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
    CREATE TABLE seo_drift_snapshots (
      id TEXT PRIMARY KEY,
      baseline_id TEXT NOT NULL,
      url TEXT NOT NULL,
      canonical_url TEXT,
      title TEXT,
      meta_description TEXT,
      h1 TEXT,
      schema_json_ld TEXT,
      robots_meta TEXT,
      status_code INTEGER,
      indexable INTEGER NOT NULL DEFAULT true,
      word_count INTEGER NOT NULL DEFAULT 0,
      external_link_count INTEGER NOT NULL DEFAULT 0,
      headers_json TEXT,
      captured_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
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
    DELETE FROM seo_drift_snapshots;
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

async function seedBaseline(input: {
  id: string;
  projectId: string;
  name?: string;
  createdAt?: string;
}) {
  await client.execute({
    sql: "INSERT INTO seo_drift_baselines (id, project_id, name, created_at) VALUES (?, ?, ?, ?)",
    args: [
      input.id,
      input.projectId,
      input.name ?? input.id,
      input.createdAt ?? "2026-09-01T00:00:00.000Z",
    ],
  });
}

function snapshotRow(input: {
  id: string;
  baselineId: string;
  url: string;
  capturedAt: string;
  title?: string;
}) {
  return {
    id: input.id,
    baselineId: input.baselineId,
    url: input.url,
    title: input.title ?? null,
    indexable: true,
    capturedAt: input.capturedAt,
  };
}

describe("createBaseline / getBaseline", () => {
  it("round-trips a baseline and scopes reads to the project", async () => {
    await seedProject("proj_1");
    await DriftRepository.createBaseline({
      id: "base_1",
      projectId: "proj_1",
      name: "Week 39",
      createdAt: "2026-09-22T00:00:00.000Z",
    });

    const found = await DriftRepository.getBaseline({
      baselineId: "base_1",
      projectId: "proj_1",
    });
    expect(found).toMatchObject({
      id: "base_1",
      name: "Week 39",
      createdAt: "2026-09-22T00:00:00.000Z",
    });

    // Another project must not see it.
    expect(
      await DriftRepository.getBaseline({
        baselineId: "base_1",
        projectId: "proj_other",
      }),
    ).toBeNull();
    expect(
      await DriftRepository.getBaseline({
        baselineId: "missing",
        projectId: "proj_1",
      }),
    ).toBeNull();
  });
});

describe("insertSnapshots / getSnapshotsForBaseline", () => {
  it("stores snapshots and returns them for the baseline ordered by url", async () => {
    await seedProject("proj_1");
    await seedBaseline({ id: "base_1", projectId: "proj_1" });
    await seedProject("proj_other");
    await seedBaseline({ id: "base_other", projectId: "proj_other" });

    await DriftRepository.insertSnapshots([
      snapshotRow({
        id: "snap_b",
        baselineId: "base_1",
        url: "https://example.com/b",
        capturedAt: "2026-09-22T01:00:00.000Z",
        title: "Page B",
      }),
      snapshotRow({
        id: "snap_a",
        baselineId: "base_1",
        url: "https://example.com/a",
        capturedAt: "2026-09-22T01:00:00.000Z",
        title: "Page A",
      }),
      snapshotRow({
        id: "snap_other",
        baselineId: "base_other",
        url: "https://example.com/a",
        capturedAt: "2026-09-22T01:00:00.000Z",
      }),
    ]);

    const snapshots = await DriftRepository.getSnapshotsForBaseline("base_1");
    expect(snapshots.map((snapshot) => snapshot.id)).toEqual([
      "snap_a",
      "snap_b",
    ]);
    expect(snapshots[0]).toMatchObject({
      url: "https://example.com/a",
      title: "Page A",
      indexable: true,
    });
  });
});

describe("getSnapshotsForUrl", () => {
  it("returns project-scoped history newest first with baseline names", async () => {
    await seedProject("proj_1");
    await seedProject("proj_other");
    await seedBaseline({
      id: "base_old",
      projectId: "proj_1",
      name: "Week 38",
      createdAt: "2026-09-15T00:00:00.000Z",
    });
    await seedBaseline({
      id: "base_new",
      projectId: "proj_1",
      name: "Week 39",
      createdAt: "2026-09-22T00:00:00.000Z",
    });
    await seedBaseline({ id: "base_other", projectId: "proj_other" });

    await DriftRepository.insertSnapshots([
      snapshotRow({
        id: "snap_old",
        baselineId: "base_old",
        url: "https://example.com/page",
        capturedAt: "2026-09-15T02:00:00.000Z",
      }),
      snapshotRow({
        id: "snap_new",
        baselineId: "base_new",
        url: "https://example.com/page",
        capturedAt: "2026-09-22T02:00:00.000Z",
      }),
      snapshotRow({
        id: "snap_other",
        baselineId: "base_other",
        url: "https://example.com/page",
        capturedAt: "2026-09-23T00:00:00.000Z",
      }),
    ]);

    const history = await DriftRepository.getSnapshotsForUrl({
      projectId: "proj_1",
      url: "https://example.com/page",
      limit: 5,
    });
    expect(history.map((row) => row.id)).toEqual(["snap_new", "snap_old"]);
    expect(history.map((row) => row.baselineName)).toEqual([
      "Week 39",
      "Week 38",
    ]);

    const limited = await DriftRepository.getSnapshotsForUrl({
      projectId: "proj_1",
      url: "https://example.com/page",
      limit: 1,
    });
    expect(limited.map((row) => row.id)).toEqual(["snap_new"]);
  });
});
