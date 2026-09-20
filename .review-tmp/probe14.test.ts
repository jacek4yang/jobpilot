import { describe, expect, it } from "vitest";
import { createRepository } from "../src/application/repository";
import { createNullLogger } from "../src/infrastructure/logging/logger";
import { CURRENT_SCHEMA_VERSION } from "../src/config/schema";

const logger = createNullLogger();

const makeStorage = (initial: unknown) => {
  let value: unknown = initial;
  return {
    store: { get: async () => value, set: async (_k: string, v: unknown) => { value = v; },
             delete: async () => { value = undefined; },
             keys: async () => [], clear: async () => { value = undefined; } },
    peek: () => value,
  };
};

describe("probe14: repository.load then save destroys data?", () => {
  it("A) document from a NEWER build", async () => {
    const historical = { jobId: "job-1", platform: "boss", status: "submitted" };
    const s = makeStorage({
      schemaVersion: CURRENT_SCHEMA_VERSION + 1,
      config: {},
      applications: [historical],
      statistics: { applied: 42 },
    });
    const repo = createRepository(s.store as never, logger);
    const loaded = await repo.load();
    console.log("A loaded.applications:", JSON.stringify(loaded.applications));
    console.log("A warnings:", JSON.stringify(loaded.warnings));
    // Now bootstrap would persist on the next transition:
    await repo.save({ config: loaded.config, applications: loaded.applications });
    console.log("A AFTER SAVE, stored:", JSON.stringify(s.peek()));
  });

  it("B) unparseable/malformed document", async () => {
    const historical = { jobId: "job-2", platform: "boss", status: "submitted" };
    const s = makeStorage({
      schemaVersion: "not-a-number",
      applications: [historical],
    });
    const repo = createRepository(s.store as never, logger);
    const loaded = await repo.load();
    console.log("B loaded.applications:", JSON.stringify(loaded.applications));
    console.log("B warnings:", JSON.stringify(loaded.warnings));
    await repo.save({ config: loaded.config, applications: loaded.applications });
    console.log("B AFTER SAVE, stored.applications:", JSON.stringify((s.peek() as any).applications));
  });

  it("C) config section corrupt -> does migrate wipe other sections?", async () => {
    const historical = { jobId: "job-3", platform: "boss", status: "submitted" };
    const s = makeStorage({
      schemaVersion: 4,
      config: "totally-not-an-object",
      applications: [historical],
      statistics: { applied: 7 },
    });
    const repo = createRepository(s.store as never, logger);
    const loaded = await repo.load();
    console.log("C loaded.applications:", JSON.stringify(loaded.applications));
    console.log("C warnings:", JSON.stringify(loaded.warnings));
  });
});
