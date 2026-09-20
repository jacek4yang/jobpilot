import { describe, expect, it } from "vitest";
import { MemoryStorage } from "../../../src/adapters/storage/memory-storage";
import { createRepository, STORAGE_KEY } from "../../../src/application/repository";
import { CURRENT_SCHEMA_VERSION } from "../../../src/config/schema";
import { createIntent, hasSendBeenAttempted } from "../../../src/domain/communication/intent";
import { asJobId } from "../../../src/domain/support/ids";
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

describe("in-flight communication transaction", () => {
  /**
   * The reload-safety guarantee. The runner commits the point of no return
   * before clicking and the adapter records the click itself; both must
   * outlive the page, or a reload between them would permit a second send.
   */
  const intent = (overrides: Partial<Parameters<typeof createIntent>[0]> = {}) =>
    createIntent({
      id: "intent-1",
      jobId: asJobId("job-1"),
      sourceUrl: "https://www.zhipin.com/web/geek/job",
      messageText: "您好",
      outgoingBaseline: 0,
      now: 1_700_000_000_000,
      ttlMs: 180_000,
      expectedJobTitle: "后端开发工程师",
      ...overrides,
    });

  it("round-trips a committed transaction across a reload", async () => {
    const storage = new MemoryStorage();
    const repository = createRepository(storage, logger);

    const loaded = await repository.load();
    const committed = {
      ...intent(),
      phase: "send-attempted" as const,
      sendAttemptedAt: 1_700_000_000_000,
    };

    await repository.save({
      config: loaded.config,
      applications: [],
      pendingIntent: committed,
    });

    const reloaded = await repository.load();
    expect(reloaded.pendingIntent).toBeDefined();
    expect(reloaded.pendingIntent?.phase).toBe("send-attempted");
    expect(reloaded.pendingIntent?.sendAttemptedAt).toBe(1_700_000_000_000);
  });

  it("preserves clickDispatched, which is what forbids a second click", async () => {
    const storage = new MemoryStorage();
    const repository = createRepository(storage, logger);
    const loaded = await repository.load();

    await repository.save({
      config: loaded.config,
      applications: [],
      pendingIntent: {
        ...intent(),
        phase: "send-attempted" as const,
        sendAttemptedAt: 1_700_000_000_000,
        clickDispatched: 1_700_000_000_500,
      },
    });

    const reloaded = await repository.load();
    // Without this field surviving, a reload would look like "committed but
    // never clicked" and the runner could click again.
    expect(reloaded.pendingIntent?.clickDispatched).toBe(1_700_000_000_500);
    expect(
      reloaded.pendingIntent === undefined ? true : hasSendBeenAttempted(reloaded.pendingIntent),
    ).toBe(true);
  });

  it("reports no transaction when none was stored", async () => {
    const repository = createRepository(new MemoryStorage(), logger);
    const loaded = await repository.load();
    expect(loaded.pendingIntent).toBeUndefined();
  });

  it("discards an unreadable transaction rather than guessing at it", async () => {
    const storage = new MemoryStorage({
      [STORAGE_KEY]: {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        config: {},
        applications: [],
        statistics: {},
        pendingIntent: { id: "broken", phase: "not-a-phase" },
      },
    });
    const repository = createRepository(storage, logger);

    const loaded = await repository.load();
    // A half-parsed transaction must never authorise a send, so it is dropped
    // and the user is told, rather than being reconstructed optimistically.
    expect(loaded.pendingIntent).toBeUndefined();
    expect(loaded.warnings.join(" ")).toContain("unreadable");
  });

  it("omits the field entirely once no transaction is in flight", async () => {
    const storage = new MemoryStorage();
    const repository = createRepository(storage, logger);
    const loaded = await repository.load();

    await repository.save({ config: loaded.config, applications: [], pendingIntent: intent() });
    await repository.save({ config: loaded.config, applications: [], pendingIntent: undefined });

    const stored = await storage.get<Record<string, unknown>>(STORAGE_KEY);
    expect("pendingIntent" in (stored ?? {})).toBe(false);
  });
});
