import type { PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { mockDeep, type DeepMockProxy } from "vitest-mock-extended";
import type { Location, Service } from "@staticforge/schemas";

import {
  describeSyncDiff,
  diffSyncPayload,
  fingerprintLocation,
  fingerprintService,
  loadSyncSnapshot,
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
});

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
    expect(enqueue).toHaveBeenCalledWith("prj_1", "local-operator");
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
