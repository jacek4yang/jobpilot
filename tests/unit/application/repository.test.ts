import { describe, expect, it } from "vitest";
import { MemoryStorage } from "../../../src/adapters/storage/memory-storage";
import { createRepository, STORAGE_KEY } from "../../../src/application/repository";
import { CURRENT_SCHEMA_VERSION } from "../../../src/config/schema";
import { createNullLogger } from "../../../src/infrastructure/logging/logger";

const logger = createNullLogger();

const repo = (seed?: Record<string, unknown>) =>
  createRepository(new MemoryStorage(seed ?? {}), logger);

describe("repository", () => {
  describe("fresh storage", () => {
    it("reports a fresh load with defaults and allows writes", async () => {
      const result = await repo().load();
      expect(result.fresh).toBe(true);
      expect(result.applications).toEqual([]);
      expect(result.writeBlocked).toBe(false);
    });
  });

  describe("round trip", () => {
    it("saves and reloads an application record", async () => {
      const storage = new MemoryStorage();
      const repository = createRepository(storage, logger);

      const loaded = await repository.load();
      const saved = await repository.save({
        config: loaded.config,
        applications: [
          {
            id: "app_1" as never,
            jobId: "job-1" as never,
            platform: "boss" as never,
            status: "verified" as never,
            attempts: 1,
            reasons: ["done"],
            createdAt: 1_700_000_000_000,
            updatedAt: 1_700_000_000_000,
          },
        ],
      });
      expect(saved.saved).toBe(true);

      const reloaded = await repository.load();
      expect(reloaded.applications).toHaveLength(1);
      expect(reloaded.applications[0]?.status).toBe("verified");
    });
  });

  describe("unreadable stored data is preserved, not overwritten", () => {
    /**
     * Regression for a demonstrated data-loss defect.
     *
     * `migratePersistedRoot` refuses a document from a NEWER schema version
     * precisely so it is not damaged. That refusal used to be converted into
     * "empty defaults + writes allowed", so the next save replaced an intact
     * document with `applications: []`. Refusing to read must also mean refusing
     * to write.
     */
    it("blocks writes when the stored schema version is too new", async () => {
      const storage = new MemoryStorage({
        [STORAGE_KEY]: {
          schemaVersion: CURRENT_SCHEMA_VERSION + 1,
          config: {},
          applications: [
            {
              jobId: "real-history",
              platform: "boss",
              status: "verified",
              createdAt: 1_700_000_000_000,
            },
          ],
          statistics: { applied: 42 },
        },
      });
      const repository = createRepository(storage, logger);

      const loaded = await repository.load();
      expect(loaded.writeBlocked).toBe(true);
      expect(loaded.warnings.join(" ")).toContain("read-only");

      // The save must be refused...
      const attempted = await repository.save({ config: loaded.config, applications: [] });
      expect(attempted.saved).toBe(false);

      // ...and the stored document must be intact: the history record and the
      // statistics are both still there, and the schema version is untouched.
      const stillThere = await storage.get<Record<string, unknown>>(STORAGE_KEY);
      expect(stillThere?.["schemaVersion"]).toBe(CURRENT_SCHEMA_VERSION + 1);
      expect(stillThere?.["statistics"]).toEqual({ applied: 42 });
      const storedApplications = stillThere?.["applications"];
      expect(Array.isArray(storedApplications)).toBe(true);
      expect(Array.isArray(storedApplications) ? storedApplications.length : 0).toBe(1);
    });

    it("blocks writes when schemaVersion is not a number", async () => {
      const storage = new MemoryStorage({
        [STORAGE_KEY]: { schemaVersion: "not-a-number", applications: [{ jobId: "keep" }] },
      });
      const repository = createRepository(storage, logger);

      const loaded = await repository.load();
      expect(loaded.writeBlocked).toBe(true);

      const attempted = await repository.save({ config: loaded.config, applications: [] });
      expect(attempted.saved).toBe(false);

      const stillThere = await storage.get<Record<string, unknown>>(STORAGE_KEY);
      expect(stillThere?.["schemaVersion"]).toBe("not-a-number");
    });

    it("keeps the write block sticky for the repository's lifetime", async () => {
      const storage = new MemoryStorage({
        [STORAGE_KEY]: { schemaVersion: 999, applications: [] },
      });
      const repository = createRepository(storage, logger);

      await repository.load();
      // Even after a subsequent load, a blocked repository stays blocked: the
      // on-disk data was never ours to replace.
      await repository.load();
      const attempted = await repository.save({
        config: (await repository.load()).config,
        applications: [],
      });
      expect(attempted.saved).toBe(false);
    });
  });

  describe("readable data is migratable and writable", () => {
    it("migrates an older document and then allows writes", async () => {
      const storage = new MemoryStorage({
        [STORAGE_KEY]: { schemaVersion: 1, config: {}, applications: [], statistics: {} },
      });
      const repository = createRepository(storage, logger);

      const loaded = await repository.load();
      expect(loaded.writeBlocked).toBe(false);
      expect(loaded.warnings.join(" ")).toContain("applied migrations");

      const saved = await repository.save({ config: loaded.config, applications: [] });
      expect(saved.saved).toBe(true);

      const stored = await storage.get<Record<string, unknown>>(STORAGE_KEY);
      expect(stored?.["schemaVersion"]).toBe(CURRENT_SCHEMA_VERSION);
    });

    it("drops malformed application records but still allows writes", async () => {
      const storage = new MemoryStorage({
        [STORAGE_KEY]: {
          schemaVersion: CURRENT_SCHEMA_VERSION,
          config: {},
          applications: [
            {
              jobId: "ok",
              platform: "boss",
              status: "verified",
              createdAt: 1,
              updatedAt: 1,
            },
            null,
            42,
          ],
          statistics: {},
        },
      });
      const repository = createRepository(storage, logger);

      const loaded = await repository.load();
      expect(loaded.writeBlocked).toBe(false);
      expect(loaded.applications).toHaveLength(1);
      expect(loaded.warnings.join(" ")).toContain("malformed");
    });
  });
});
