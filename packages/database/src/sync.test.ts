import type { PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { mockDeep, type DeepMockProxy } from "vitest-mock-extended";

import { armQuotaGate, holdsWritten } from "./quota.fixtures.js";
import type { Location, Service } from "@staticforge/schemas";

import {
  changesPageSet,
  describeSyncDiff,
  diffSyncPayload,
  fingerprintLocation,
  fingerprintService,
  loadSyncSnapshot,
  planSyncRun,
  syncProject,
  type SyncSnapshot,
} from "./sync.js";

/**
 * Change detection, which is the part that decides whether money is spent.
 *
 * These sources re-send by nature: a nightly cron re-uploads the same sheet, a
 * CRM fires on a field nobody uses, an operator clicks twice. On a project with
 * AI authoring enabled, a sync that queued a run every time would buy a few
 * hundred pages of prose identical to the prose already stored — every night,
 * forever, with nothing to show for it.
 *
 * So the tests that matter most here are the ones asserting that *nothing*
 * happens.
 */

let prisma: DeepMockProxy<PrismaClient>;

beforeEach(() => {
  prisma = mockDeep<PrismaClient>();
  // Phase 23: a sync is gated on `project:write`. Unless a test says otherwise,
  // the caller is an OWNER — these suites are about change detection, not about
  // access, and an unarmed membership would make every one of them fail for the
  // wrong reason.
  armRole("OWNER");
  // No quota configured, which is what every suite outside the quota one
  // assumes. The quota tests arm their own.
  armQuotaGate(prisma, { limit: null });
});

/** Arm the membership lookup the authorisation gate reads. */
function armRole(role: "OWNER" | "EDITOR" | "VIEWER" | null): void {
  prisma.organizationMember.findUnique.mockResolvedValue(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (role === null ? null : { role }) as any,
  );
}

const service: Service = {
  id: "svc-1",
  name: "Büroreinigung",
  slug: "bueroreinigung",
  description: "S".repeat(120),
  benefits: ["a", "b", "c"],
};

const location: Location = {
  id: "loc-1",
  city: "Duisburg",
  state: "NRW",
  country: "DE",
};

/** A snapshot holding exactly the fixtures above. */
function snapshotOf(
  services: Service[] = [service],
  locations: Location[] = [location],
): SyncSnapshot {
  return {
    organizationId: "org-1",
    services: new Map(services.map((item) => [item.id, fingerprintService(item)])),
    locations: new Map(locations.map((item) => [item.id, fingerprintLocation(item)])),
  };
}

describe("nothing changed means nothing happens", () => {
  test("identical data reports no change", () => {
    const diff = diffSyncPayload(
      { services: [service], locations: [location] },
      snapshotOf(),
    );

    expect(diff.changed).toBe(false);
    expect(describeSyncDiff(diff)).toBe("no changes");
  });

  test("re-sending in a different order is not a change", () => {
    // A source that returns rows unordered must not look like an edit every
    // time it happens to return them differently.
    const second: Service = { ...service, id: "svc-2", slug: "grundreinigung" };
    const diff = diffSyncPayload(
      { services: [second, service] },
      snapshotOf([service, second]),
    );

    expect(diff.changed).toBe(false);
  });

  test("a field that never reaches a page is not a change", () => {
    // The fingerprint covers what the generator and the grounding record read.
    // A source rewriting a timestamp on every row must register as no change,
    // or the guard is decorative.
    const withNoise = { ...service } as Service & { updatedAt?: string };
    withNoise.updatedAt = new Date().toISOString();

    expect(fingerprintService(withNoise)).toBe(fingerprintService(service));
  });

  test("a collection the source did not mention is not a deletion", () => {
    // The distinction that decides whether a partial sync is useful or
    // catastrophic: a sheet listing only locations must not clear the services.
    const diff = diffSyncPayload({ locations: [location] }, snapshotOf());

    expect(diff.changed).toBe(false);
    expect(diff.services.removed).toEqual([]);
  });

  test("an unchanged sync writes nothing and queues nothing", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prisma.project.findFirst.mockResolvedValue({
      id: "prj_1",
      organizationId: "org-1",
      services: [
        {
          id: "svc-1",
          name: service.name,
          slug: service.slug,
          description: service.description,
          benefits: service.benefits,
          priceFrom: null,
          priceTo: null,
          priceCurrency: null,
          templateId: null,
          contentProfileId: null,
        },
      ],
      locations: [
        {
          id: "loc-1",
          city: "Duisburg",
          state: "NRW",
          country: "DE",
          postalCode: null,
          latitude: null,
          longitude: null,
        },
      ],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const enqueue = vi.fn().mockResolvedValue("job_1");

    const result = await syncProject(
      "prj_1",
      "local-operator",
      { services: [service], locations: [location] },
      prisma,
      { enqueueJob: enqueue },
    );

    // The whole feature, in three assertions.
    expect(result?.changed).toBe(false);
    expect(result?.jobId).toBeNull();
    expect(enqueue).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe("a real change is detected and queued", () => {
  /** Arm the snapshot read with a project holding the fixtures. */
  function armSnapshot(): void {
    prisma.project.findFirst.mockResolvedValue({
      id: "prj_1",
      organizationId: "org-1",
      services: [
        {
          id: "svc-1",
          name: service.name,
          slug: service.slug,
          description: service.description,
          benefits: service.benefits,
          priceFrom: null,
          priceTo: null,
          priceCurrency: null,
          templateId: null,
          contentProfileId: null,
        },
      ],
      locations: [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    prisma.$transaction.mockImplementation(((
      run: (tx: typeof prisma) => Promise<unknown>,
    ) => run(prisma)) as unknown as typeof prisma.$transaction);
    // The project has one generated page, for the service these tests edit.
    // Armed here because a sync now asks which pages a change reached before it
    // decides what to queue.
    prisma.generatedPage.findMany.mockResolvedValue([
      {
        id: "pg_1",
        slug: "bueroreinigung-duisburg",
        serviceId: "svc-1",
        locationId: "loc-1",
        source: "AI",
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any);
  }

  test("an edited description is a change", () => {
    const edited: Service = { ...service, description: "D".repeat(140) };
    const diff = diffSyncPayload({ services: [edited] }, snapshotOf());

    expect(diff.changed).toBe(true);
    expect(diff.services.updated).toEqual(["svc-1"]);
  });

  test("a new entity is a change", () => {
    const added: Service = { ...service, id: "svc-2", slug: "grundreinigung" };
    const diff = diffSyncPayload({ services: [service, added] }, snapshotOf());

    expect(diff.services.added).toEqual(["svc-2"]);
  });

  test("an entity dropped from a mentioned collection is a removal", () => {
    const diff = diffSyncPayload({ services: [] }, snapshotOf());

    // An explicitly empty list *is* an instruction, unlike an absent one.
    expect(diff.services.removed).toEqual(["svc-1"]);
    expect(diff.changed).toBe(true);
  });

  test("a moved content profile is a change, because it changes the page", () => {
    const moved: Service = { ...service, contentProfileId: "strictSeo" };

    expect(fingerprintService(moved)).not.toBe(fingerprintService(service));
  });

  test("a changed price is a change, because grounding reads it", () => {
    const priced: Service = {
      ...service,
      pricing: { from: 20, to: 40, currency: "EUR" },
    };

    expect(fingerprintService(priced)).not.toBe(fingerprintService(service));
  });

  test("a changed sync writes and queues exactly one run", async () => {
    armSnapshot();
    const enqueue = vi.fn().mockResolvedValue("job_1");
    const edited: Service = { ...service, description: "D".repeat(140) };

    const result = await syncProject(
      "prj_1",
      "local-operator",
      { services: [edited] },
      prisma,
      { enqueueJob: enqueue },
    );

    expect(result?.changed).toBe(true);
    expect(result?.jobId).toBe("job_1");
    expect(enqueue).toHaveBeenCalledTimes(1);
    // Scoped to the one page the edited service actually reaches, rather than
    // to the project.
    expect(enqueue).toHaveBeenCalledWith("prj_1", "local-operator", [
      "bueroreinigung-duisburg",
    ]);
    expect(result?.scope).toEqual(["bueroreinigung-duisburg"]);
  });

  test("a dry run reports the change and queues nothing", async () => {
    armSnapshot();
    const enqueue = vi.fn();
    const edited: Service = { ...service, description: "D".repeat(140) };

    const result = await syncProject(
      "prj_1",
      "local-operator",
      { services: [edited] },
      prisma,
      { enqueue: false, enqueueJob: enqueue },
    );

    expect(result?.changed).toBe(true);
    expect(enqueue).not.toHaveBeenCalled();
    // "Dry run" means no side effects, not "side effects but no job": the
    // question is what a sheet *would* do, and answering it from the far side
    // of the transaction would have already changed the answer.
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  test("the write happens in one transaction", async () => {
    armSnapshot();
    const edited: Service = { ...service, description: "D".repeat(140) };

    await syncProject("prj_1", "local-operator", { services: [edited] }, prisma, {
      enqueueJob: vi.fn().mockResolvedValue("job_1"),
    });

    // A sync that failed half-way would leave a project describing services it
    // no longer has locations for, and the run queued after it would publish
    // exactly that.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});

describe("tenant scoping", () => {
  test("the snapshot read carries the owner", async () => {
    prisma.project.findFirst.mockResolvedValue(null as never);

    await loadSyncSnapshot("prj_1", "user_a", prisma);

    expect(prisma.project.findFirst.mock.calls[0]?.[0]?.where).toEqual({
      id: "prj_1",
      userId: "user_a",
    });
  });

  test("a project that is not the caller's syncs nothing", async () => {
    prisma.project.findFirst.mockResolvedValue(null as never);
    const enqueue = vi.fn();

    const result = await syncProject(
      "prj_1",
      "user_other",
      { services: [service] },
      prisma,
      { enqueueJob: enqueue },
    );

    // Null, not an error mentioning the project: a sync must not become a way
    // to discover which ids are real.
    expect(result).toBeNull();
    expect(enqueue).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe("describeSyncDiff", () => {
  test("summarises what moved", () => {
    const added: Service = { ...service, id: "svc-2", slug: "grundreinigung" };
    const diff = diffSyncPayload({ services: [service, added] }, snapshotOf());

    expect(describeSyncDiff(diff)).toBe("services: 1 added, 0 updated, 0 removed");
  });

  test("says so plainly when nothing moved", () => {
    expect(describeSyncDiff(diffSyncPayload({}, snapshotOf()))).toBe("no changes");
  });
});

// ---------------------------------------------------------------------------
// Smart queuing: which pages a change actually buys
// ---------------------------------------------------------------------------

/**
 * A sync used to queue a run over the whole project, which was fine while a
 * project was a demo and wrong the moment one was a customer. Editing one
 * service in a forty-city account re-authored two hundred pages to change five.
 *
 * These tests hold the two properties that replace it, and both are asserted
 * against a page table that actually honours the query rather than against a
 * stub returning a fixed answer. That matters: a stub would pass just as
 * happily if the `source` filter were deleted, which is precisely the mutation
 * these tests exist to catch.
 */

/** A row in the fake page table. */
interface StoredPageRow {
  id: string;
  slug: string;
  serviceId: string;
  locationId: string;
  source: "TEMPLATE" | "AI" | "MANUAL";
}

/**
 * Stand a page table up behind `findMany`, honouring the filters it is given.
 *
 * Faithful to Postgres in the one way that matters here: an *absent* filter
 * restricts nothing. So a run that stops filtering by source sees every row,
 * including the hand-edited ones, and the tests below fail — which is the whole
 * point of writing the fake this way rather than returning a fixed list.
 */
function armPageTable(rows: StoredPageRow[]): void {
  prisma.generatedPage.findMany.mockImplementation((async (args: {
    where: {
      projectId?: string;
      source?: { in?: string[] };
      OR?: Array<{ serviceId?: { in: string[] }; locationId?: { in: string[] } }>;
    };
  }) => {
    const { where } = args;
    const allowed = where.source?.in;
    const clauses = where.OR;

    return rows
      .filter(() => where.projectId === undefined || where.projectId === "prj_1")
      .filter((row) => allowed === undefined || allowed.includes(row.source))
      .filter(
        (row) =>
          clauses === undefined ||
          clauses.some(
            (clause) =>
              (clause.serviceId?.in.includes(row.serviceId) ?? false) ||
              (clause.locationId?.in.includes(row.locationId) ?? false),
          ),
      )
      .sort((a, b) => a.slug.localeCompare(b.slug));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any);
}

/** A second service, so a change can be shown not to reach it. */
const SERVICE_B: Service = {
  ...service,
  id: "svc-2",
  name: "Grundreinigung",
  slug: "grundreinigung",
};

/** Arm a project holding both services and one location. */
function armTwoServiceProject(): void {
  const row = (item: Service) => ({
    id: item.id,
    name: item.name,
    slug: item.slug,
    description: item.description,
    benefits: item.benefits,
    priceFrom: null,
    priceTo: null,
    priceCurrency: null,
    templateId: null,
    contentProfileId: null,
  });

  prisma.project.findFirst.mockResolvedValue({
    id: "prj_1",
    organizationId: "org-1",
    services: [row(service), row(SERVICE_B)],
    locations: [
      {
        id: "loc-1",
        city: "Duisburg",
        state: "NRW",
        country: "DE",
        postalCode: null,
        latitude: null,
        longitude: null,
      },
    ],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);

  prisma.$transaction.mockImplementation(((
    run: (tx: typeof prisma) => Promise<unknown>,
  ) => run(prisma)) as unknown as typeof prisma.$transaction);
}

/** The payload that edits the first service and leaves the second alone. */
function editFirstService(): { services: Service[] } {
  return {
    services: [{ ...service, description: "D".repeat(140) }, SERVICE_B],
  };
}

describe("a changed service queues only its own pages", () => {
  test("the job is scoped to the edited service's page, not the project's", async () => {
    armTwoServiceProject();
    armPageTable([
      {
        id: "pg_1",
        slug: "bueroreinigung-duisburg",
        serviceId: "svc-1",
        locationId: "loc-1",
        source: "AI",
      },
      {
        id: "pg_2",
        slug: "grundreinigung-duisburg",
        serviceId: "svc-2",
        locationId: "loc-1",
        source: "AI",
      },
    ]);

    const enqueue = vi.fn().mockResolvedValue("job_1");

    const result = await syncProject(
      "prj_1",
      "local-operator",
      editFirstService(),
      prisma,
      { enqueueJob: enqueue },
    );

    // The feature, in one assertion: the untouched service's page is not bought.
    expect(result?.scope).toEqual(["bueroreinigung-duisburg"]);
    expect(enqueue).toHaveBeenCalledWith("prj_1", "local-operator", [
      "bueroreinigung-duisburg",
    ]);
  });

  test("a changed city reaches every service in it", async () => {
    armPageTable([
      {
        id: "pg_1",
        slug: "bueroreinigung-duisburg",
        serviceId: "svc-1",
        locationId: "loc-1",
        source: "AI",
      },
      {
        id: "pg_2",
        slug: "grundreinigung-duisburg",
        serviceId: "svc-2",
        locationId: "loc-1",
        source: "AI",
      },
      {
        id: "pg_3",
        slug: "bueroreinigung-essen",
        serviceId: "svc-1",
        locationId: "loc-2",
        source: "AI",
      },
    ]);

    const plan = await planSyncRun(
      "prj_1",
      "local-operator",
      {
        services: { added: [], updated: [], removed: [] },
        locations: { added: [], updated: ["loc-1"], removed: [] },
        changed: true,
      },
      prisma,
    );

    // Both services in Duisburg, and nothing in Essen.
    expect(plan.scope).toEqual([
      "bueroreinigung-duisburg",
      "grundreinigung-duisburg",
    ]);
  });

  test("an added service forces a full run, because a scope cannot create a page", async () => {
    const added = diffSyncPayload(
      { services: [service, SERVICE_B] },
      {
        organizationId: "org-1",
        services: new Map([["svc-1", fingerprintService(service)]]),
        locations: new Map(),
      },
    );

    expect(changesPageSet(added)).toBe(true);

    const plan = await planSyncRun("prj_1", "local-operator", added, prisma);

    // Scoping this would queue a job for pages that do not exist, do nothing,
    // report success, and leave the new service unpublished with no error
    // anywhere.
    expect(plan.queue).toBe(true);
    expect(plan.scope).toEqual([]);
    expect(prisma.generatedPage.findMany).not.toHaveBeenCalled();
  });

  test("a removed service forces a full run, because the link graph moved", async () => {
    const removed = diffSyncPayload(
      { services: [] },
      {
        organizationId: "org-1",
        services: new Map([["svc-1", fingerprintService(service)]]),
        locations: new Map(),
      },
    );

    expect(changesPageSet(removed)).toBe(true);

    const plan = await planSyncRun("prj_1", "local-operator", removed, prisma);

    expect(plan.scope).toEqual([]);
    expect(prisma.generatedPage.findMany).not.toHaveBeenCalled();
  });
});

describe("a hand-edited page is never queued", () => {
  test("a MANUAL page is left out of the scope", async () => {
    armTwoServiceProject();
    armPageTable([
      // The operator has edited this one by hand.
      {
        id: "pg_1",
        slug: "bueroreinigung-duisburg",
        serviceId: "svc-1",
        locationId: "loc-1",
        source: "MANUAL",
      },
      {
        id: "pg_2",
        slug: "grundreinigung-duisburg",
        serviceId: "svc-2",
        locationId: "loc-1",
        source: "AI",
      },
    ]);

    const enqueue = vi.fn().mockResolvedValue("job_1");

    await syncProject("prj_1", "local-operator", editFirstService(), prisma, {
      enqueueJob: enqueue,
    });

    // Nothing was queued, because the only page the change reached is one no
    // automated run may rewrite.
    expect(enqueue).not.toHaveBeenCalled();
  });

  test("when only some reached pages are MANUAL, the rest are still queued", async () => {
    armTwoServiceProject();
    armPageTable([
      {
        id: "pg_1",
        slug: "bueroreinigung-duisburg",
        serviceId: "svc-1",
        locationId: "loc-1",
        source: "MANUAL",
      },
      {
        id: "pg_2",
        slug: "bueroreinigung-essen",
        serviceId: "svc-1",
        locationId: "loc-2",
        source: "AI",
      },
    ]);

    const enqueue = vi.fn().mockResolvedValue("job_1");

    const result = await syncProject(
      "prj_1",
      "local-operator",
      editFirstService(),
      prisma,
      { enqueueJob: enqueue },
    );

    // The protection is per page, not per sync: one hand-edited page must not
    // stop the others being refreshed, or an operator editing a single page
    // would silently freeze the rest of the service.
    expect(result?.scope).toEqual(["bueroreinigung-essen"]);
    expect(result?.scope).not.toContain("bueroreinigung-duisburg");
  });

  test("a MANUAL page is excluded even when both its service and its city changed", async () => {
    armPageTable([
      {
        id: "pg_1",
        slug: "bueroreinigung-duisburg",
        serviceId: "svc-1",
        locationId: "loc-1",
        source: "MANUAL",
      },
    ]);

    const plan = await planSyncRun(
      "prj_1",
      "local-operator",
      {
        services: { added: [], updated: ["svc-1"], removed: [] },
        locations: { added: [], updated: ["loc-1"], removed: [] },
        changed: true,
      },
      prisma,
    );

    // Matching twice is not a way in. The `OR` finds the row through either
    // side, and the source filter refuses it through both.
    expect(plan.queue).toBe(false);
    expect(plan.scope).toEqual([]);
  });

  test("a project of nothing but hand-edited pages queues nothing, ever", async () => {
    armTwoServiceProject();
    armPageTable([
      {
        id: "pg_1",
        slug: "bueroreinigung-duisburg",
        serviceId: "svc-1",
        locationId: "loc-1",
        source: "MANUAL",
      },
      {
        id: "pg_2",
        slug: "grundreinigung-duisburg",
        serviceId: "svc-2",
        locationId: "loc-1",
        source: "MANUAL",
      },
    ]);

    const enqueue = vi.fn().mockResolvedValue("job_1");

    const result = await syncProject(
      "prj_1",
      "local-operator",
      editFirstService(),
      prisma,
      { enqueueJob: enqueue },
    );

    expect(enqueue).not.toHaveBeenCalled();
    expect(result?.jobId).toBeNull();
    // The data was still applied — the source is authoritative about it — and
    // the sync says why it stopped there rather than reporting a plain success
    // an operator would read as "the pages were rebuilt".
    expect(result?.changed).toBe(true);
    expect(result?.note).toMatch(/no run was queued/i);
  });

  test("the sync still announces itself when it queues nothing", async () => {
    armTwoServiceProject();
    armPageTable([
      {
        id: "pg_1",
        slug: "bueroreinigung-duisburg",
        serviceId: "svc-1",
        locationId: "loc-1",
        source: "MANUAL",
      },
    ]);

    const seen: Array<{ jobId: string | null; scopedPages: number }> = [];

    await syncProject("prj_1", "local-operator", editFirstService(), prisma, {
      enqueueJob: vi.fn().mockResolvedValue("job_1"),
      hooks: {
        on: () => {},
        count: () => 1,
        emit: async (_hook, payload) => {
          seen.push(payload as unknown as (typeof seen)[number]);
          return { hook: "afterProjectSync" as const, delivered: 1, failures: [] };
        },
      },
    });

    // "We checked and there was nothing to do" is the answer an audit trail
    // needs most often. A plugin that only heard about runs could not tell a
    // steady project from an integration that stopped calling.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.jobId).toBeNull();
    expect(seen[0]?.scopedPages).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Phase 23: no write passes without a role check
// ---------------------------------------------------------------------------

/**
 * A sync writes tenant data and enqueues paid work. It is a write in every
 * sense, and a VIEWER may not perform one.
 *
 * The tests that matter here assert what did *not* happen. A gate that refuses
 * after the transaction has already run is not a gate — it is an error message
 * printed over a completed write.
 */
describe("a VIEWER is refused a sync", () => {
  test("syncProject throws AccessDenied for a VIEWER", async () => {
    armTwoServiceProject();
    armRole("VIEWER");

    await expect(
      syncProject("prj_1", "viewer-user", editFirstService(), prisma, {
        enqueueJob: vi.fn(),
      }),
    ).rejects.toMatchObject({ name: "AccessDeniedError", heldRole: "VIEWER" });
  });

  test("nothing is written and nothing is queued", async () => {
    armTwoServiceProject();
    armPageTable([
      {
        id: "pg_1",
        slug: "bueroreinigung-duisburg",
        serviceId: "svc-1",
        locationId: "loc-1",
        source: "AI",
      },
    ]);
    armRole("VIEWER");

    const enqueue = vi.fn();

    await syncProject("prj_1", "viewer-user", editFirstService(), prisma, {
      enqueueJob: enqueue,
    }).catch(() => undefined);

    // The refusal has to precede the effects, or it is decoration.
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(prisma.service.upsert).not.toHaveBeenCalled();
    expect(prisma.location.upsert).not.toHaveBeenCalled();
  });

  test("the gate runs before the impact query, not after it", async () => {
    armTwoServiceProject();
    armRole("VIEWER");

    await syncProject("prj_1", "viewer-user", editFirstService(), prisma, {
      enqueueJob: vi.fn(),
    }).catch(() => undefined);

    // A refused caller must not learn which pages exist. An authorisation check
    // that happens after the read it protects has already disclosed the thing
    // it was protecting.
    expect(prisma.generatedPage.findMany).not.toHaveBeenCalled();
  });

  test("a dry run is refused too", async () => {
    armTwoServiceProject();
    armRole("VIEWER");

    // `--dry-run` writes nothing, which is exactly why it looks harmless. It
    // still reports what a project holds and what a change would cost, and that
    // is information a read-only member of *another* role level should get
    // through a read endpoint rather than by asking a write endpoint nicely.
    await expect(
      syncProject("prj_1", "viewer-user", editFirstService(), prisma, {
        enqueue: false,
        enqueueJob: vi.fn(),
      }),
    ).rejects.toMatchObject({ name: "AccessDeniedError" });
  });

  test("someone with no membership at all is refused, and told nothing", async () => {
    armTwoServiceProject();
    armRole(null);

    let error: { message: string; heldRole: string | null } | undefined;

    try {
      await syncProject("prj_1", "stranger", editFirstService(), prisma, {
        enqueueJob: vi.fn(),
      });
    } catch (thrown: unknown) {
      error = thrown as { message: string; heldRole: string | null };
    }

    // Asserted rather than assumed: a capture that quietly kept `undefined`
    // would make this test pass against code that allowed the sync.
    expect(error).toBeDefined();
    expect(error?.heldRole).toBeNull();
    // The same sentence an organization that does not exist would produce.
    expect(error?.message).toMatch(/^No access to organization/);
  });
});

describe("an EDITOR may sync", () => {
  test("an EDITOR passes the gate and the sync proceeds", async () => {
    armTwoServiceProject();
    armPageTable([
      {
        id: "pg_1",
        slug: "bueroreinigung-duisburg",
        serviceId: "svc-1",
        locationId: "loc-1",
        source: "AI",
      },
    ]);
    armRole("EDITOR");

    const enqueue = vi.fn().mockResolvedValue("job_1");

    const result = await syncProject(
      "prj_1",
      "editor-user",
      editFirstService(),
      prisma,
      { enqueueJob: enqueue },
    );

    expect(result?.jobId).toBe("job_1");
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  test("the check is made against the project's own organization", async () => {
    armTwoServiceProject();
    armPageTable([]);
    armRole("EDITOR");

    await syncProject("prj_1", "editor-user", editFirstService(), prisma, {
      enqueueJob: vi.fn(),
    });

    // Not against an organization the caller happened to name. The project
    // decides which membership is consulted.
    expect(prisma.organizationMember.findUnique).toHaveBeenCalledWith({
      where: {
        organizationId_userId: { organizationId: "org-1", userId: "editor-user" },
      },
      select: { role: true },
    });
  });

  test("the sync event carries the organization, so the audit row can be scoped", async () => {
    armTwoServiceProject();
    armPageTable([]);
    armRole("EDITOR");

    const seen: Array<{ organizationId: string | null }> = [];

    await syncProject("prj_1", "editor-user", editFirstService(), prisma, {
      enqueueJob: vi.fn().mockResolvedValue("job_1"),
      hooks: {
        on: () => {},
        count: () => 1,
        emit: async (_hook, payload) => {
          seen.push(payload as unknown as (typeof seen)[number]);
          return { hook: "afterProjectSync" as const, delivered: 1, failures: [] };
        },
      },
    });

    // An audit row that cannot say which organization it belongs to is one that
    // organization can never be shown.
    expect(seen[0]?.organizationId).toBe("org-1");
  });
});

// ---------------------------------------------------------------------------
// Phase 26: the quota gate, in front of the write
// ---------------------------------------------------------------------------

/**
 * A sync is one metered operation, so an exhausted tenant cannot start one.
 *
 * The checks here assert the *ordering* as much as the outcome. A quota
 * discovered when the work finishes is an invoice, not a ceiling — the pages
 * are already written and already paid for.
 */
describe("an exhausted quota refuses a sync", () => {
  /** Arm the quota row and the usage sum behind it. */
  function armQuota(limit: number | null, used = 0): void {
    armQuotaGate(prisma, { limit, used });
  }

  test("syncProject throws QuotaExceeded when there is no allowance left", async () => {
    armTwoServiceProject();
    armRole("EDITOR");
    armQuota(5, 5);

    await expect(
      syncProject("prj_1", "editor-user", editFirstService(), prisma, {
        enqueueJob: vi.fn(),
      }),
    ).rejects.toMatchObject({ name: "QuotaExceededError" });
  });

  test("nothing is written and nothing is queued", async () => {
    armTwoServiceProject();
    armPageTable([
      {
        id: "pg_1",
        slug: "bueroreinigung-duisburg",
        serviceId: "svc-1",
        locationId: "loc-1",
        source: "AI",
      },
    ]);
    armRole("EDITOR");
    armQuota(5, 5);

    const enqueue = vi.fn();

    await syncProject("prj_1", "editor-user", editFirstService(), prisma, {
      enqueueJob: enqueue,
    }).catch(() => undefined);

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  test("the refusal precedes the impact query", async () => {
    armTwoServiceProject();
    armRole("EDITOR");
    armQuota(5, 5);

    await syncProject("prj_1", "editor-user", editFirstService(), prisma, {
      enqueueJob: vi.fn(),
    }).catch(() => undefined);

    // A tenant out of allowance should not be able to keep reading which of its
    // pages would change. Refusing after the read would have already answered
    // the question.
    expect(prisma.generatedPage.findMany).not.toHaveBeenCalled();
  });

  test("permission is checked before quota, so a stranger learns nothing about billing", async () => {
    armTwoServiceProject();
    armRole(null);
    armQuota(5, 5);

    let error: Error | undefined;

    try {
      await syncProject("prj_1", "stranger", editFirstService(), prisma, {
        enqueueJob: vi.fn(),
      });
    } catch (thrown: unknown) {
      error = thrown as Error;
    }

    // A caller who may not touch this project at all should learn that, not
    // learn how much quota the organization has left.
    expect(error?.name).toBe("AccessDeniedError");
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  test("a dry run is not refused, because it is not metered", async () => {
    armTwoServiceProject();
    armPageTable([]);
    armRole("EDITOR");
    armQuota(5, 5);

    // Checking and charging have to cover the same paths. A dry run emits no
    // lifecycle event and never becomes a usage row, so refusing one would cost
    // a tenant the ability to plan and charge it nothing — and would leave the
    // gate and the meter describing different systems.
    const result = await syncProject(
      "prj_1",
      "editor-user",
      editFirstService(),
      prisma,
      { enqueue: false, enqueueJob: vi.fn() },
    );

    expect(result?.changed).toBe(true);
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
    // And nothing was held either, so a dry run cannot be used to drain a
    // tenant's allowance by asking what a sheet would do.
    expect(prisma.usageRecord.create).not.toHaveBeenCalled();
  });

  test("room left lets the sync through", async () => {
    armTwoServiceProject();
    armPageTable([
      {
        id: "pg_1",
        slug: "bueroreinigung-duisburg",
        serviceId: "svc-1",
        locationId: "loc-1",
        source: "AI",
      },
    ]);
    armRole("EDITOR");
    armQuota(100, 3);

    const enqueue = vi.fn().mockResolvedValue("job_1");

    const result = await syncProject(
      "prj_1",
      "editor-user",
      editFirstService(),
      prisma,
      { enqueueJob: enqueue },
    );

    expect(result?.jobId).toBe("job_1");
  });

  test("no configured quota does not block anything", async () => {
    armTwoServiceProject();
    // A page the change reaches, so there is something to queue — otherwise
    // this would assert the Phase 21 rule rather than the quota one.
    armPageTable([
      {
        id: "pg_1",
        slug: "bueroreinigung-duisburg",
        serviceId: "svc-1",
        locationId: "loc-1",
        source: "AI",
      },
    ]);
    armRole("EDITOR");
    armQuota(null);

    // Quotas are opt-in. Every tenant that existed before this table did must
    // keep working.
    const result = await syncProject(
      "prj_1",
      "editor-user",
      editFirstService(),
      prisma,
      { enqueueJob: vi.fn().mockResolvedValue("job_1") },
    );

    expect(result?.jobId).toBe("job_1");
  });

  test("the sync is charged as one operation, not as one per page", async () => {
    armTwoServiceProject();
    armPageTable([]);
    armRole("EDITOR");
    armQuota(100, 0);

    await syncProject("prj_1", "editor-user", editFirstService(), prisma, {
      enqueueJob: vi.fn().mockResolvedValue("job_1"),
    });

    // One unit held, whatever the sync touched. A sync is one operation
    // whether it changes nothing or five hundred pages.
    expect(holdsWritten(prisma)).toEqual([
      {
        organizationId: "org-1",
        metric: "SYNC_OPERATIONS",
        amount: 1,
        resourceId: "prj_1",
      },
    ]);
  });

  test("the gate holds the unit it admits, so concurrent syncs cannot all pass", async () => {
    armTwoServiceProject();
    armPageTable([]);
    armRole("EDITOR");
    armQuota(100, 0);

    await syncProject("prj_1", "editor-user", editFirstService(), prisma, {
      enqueueJob: vi.fn().mockResolvedValue("job_1"),
    });

    // The write is the whole fix. Checking without writing leaves nothing for
    // the next caller's sum to find, so serialising the checks would change
    // their order and not their answer — and all of them would still pass.
    expect(prisma.usageRecord.create).toHaveBeenCalledTimes(1);
  });

  test("a refused sync holds nothing", async () => {
    armTwoServiceProject();
    armRole("EDITOR");
    armQuota(5, 5);

    await syncProject("prj_1", "editor-user", editFirstService(), prisma, {
      enqueueJob: vi.fn(),
    }).catch(() => undefined);

    expect(prisma.usageRecord.create).not.toHaveBeenCalled();
  });
});
