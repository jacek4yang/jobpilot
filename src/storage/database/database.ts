/**
 * Database abstraction for JobPilot Workspace.
 *
 * Implements:
 * 1. Native IndexedDB provider when available.
 * 2. In-memory fallback provider when IndexedDB is missing or blocked (e.g. Node tests, restricted environments).
 * 3. Health monitoring and estimate storage size.
 */

import { applyWorkspaceMigrations } from "./migrations";
import { WORKSPACE_DB_NAME, WORKSPACE_DB_VERSION, type WorkspaceStoreName } from "./schema";

export type StorageHealthStatus = "healthy" | "degraded" | "read-only" | "unavailable";

export interface WorkspaceDatabase {
  readonly isHealthy: boolean;
  readonly isReadOnly: boolean;
  get<T>(storeName: WorkspaceStoreName, key: IDBValidKey): Promise<T | undefined>;
  put<T>(storeName: WorkspaceStoreName, value: T): Promise<void>;
  delete(storeName: WorkspaceStoreName, key: IDBValidKey): Promise<void>;
  getAll<T>(
    storeName: WorkspaceStoreName,
    query?: IDBValidKey | IDBKeyRange | null,
    count?: number,
  ): Promise<readonly T[]>;
  getAllFromIndex<T>(
    storeName: WorkspaceStoreName,
    indexName: string,
    query?: IDBValidKey | IDBKeyRange | null,
    count?: number,
  ): Promise<readonly T[]>;
  count(storeName: WorkspaceStoreName): Promise<number>;
  clear(storeName: WorkspaceStoreName): Promise<void>;
  estimateSize(): Promise<number>;
  close(): void;
}

/**
 * Creates an in-memory database implementing `WorkspaceDatabase`.
 * Ideal for unit testing under Node and for zero-dependency safe fallback.
 */
export const createMemoryWorkspaceDatabase = (): WorkspaceDatabase => {
  const tables = new Map<WorkspaceStoreName, Map<string, unknown>>();

  const getTable = (storeName: WorkspaceStoreName): Map<string, unknown> => {
    let table = tables.get(storeName);
    if (!table) {
      table = new Map<string, unknown>();
      tables.set(storeName, table);
    }
    return table;
  };

  const getKey = (storeName: WorkspaceStoreName, value: unknown): string => {
    if (typeof value !== "object" || value === null) {
      return String(value);
    }
    const record = value as Record<string, unknown>;
    if (storeName === "annotations" || storeName === "pipeline") {
      return String(record.jobId);
    }
    if ("id" in record) {
      return String(record.id);
    }
    if ("key" in record) {
      return String(record.key);
    }
    return String(value);
  };

  return {
    isHealthy: true,
    isReadOnly: false,
    async get<T>(storeName: WorkspaceStoreName, key: IDBValidKey): Promise<T | undefined> {
      const table = getTable(storeName);
      const val = table.get(String(key));
      return val === undefined ? undefined : (JSON.parse(JSON.stringify(val)) as T);
    },
    async put<T>(storeName: WorkspaceStoreName, value: T): Promise<void> {
      const table = getTable(storeName);
      const key = getKey(storeName, value);
      table.set(key, JSON.parse(JSON.stringify(value)));
    },
    async delete(storeName: WorkspaceStoreName, key: IDBValidKey): Promise<void> {
      const table = getTable(storeName);
      table.delete(String(key));
    },
    async getAll<T>(
      storeName: WorkspaceStoreName,
      _query?: IDBValidKey | IDBKeyRange | null,
      count?: number,
    ): Promise<readonly T[]> {
      const table = getTable(storeName);
      const all = Array.from(table.values()) as T[];
      const sliced = typeof count === "number" && count > 0 ? all.slice(0, count) : all;
      return JSON.parse(JSON.stringify(sliced)) as T[];
    },
    async getAllFromIndex<T>(
      storeName: WorkspaceStoreName,
      indexName: string,
      query?: IDBValidKey | IDBKeyRange | null,
      count?: number,
    ): Promise<readonly T[]> {
      const table = getTable(storeName);
      const all = Array.from(table.values()) as Array<Record<string, unknown>>;
      const filtered =
        query === undefined || query === null
          ? all
          : all.filter((item) => String(item[indexName]) === String(query));
      const sliced = typeof count === "number" && count > 0 ? filtered.slice(0, count) : filtered;
      return JSON.parse(JSON.stringify(sliced)) as T[];
    },
    async count(storeName: WorkspaceStoreName): Promise<number> {
      const table = getTable(storeName);
      return table.size;
    },
    async clear(storeName: WorkspaceStoreName): Promise<void> {
      const table = getTable(storeName);
      table.clear();
    },
    async estimateSize(): Promise<number> {
      let bytes = 0;
      for (const table of tables.values()) {
        for (const [k, v] of table.entries()) {
          bytes += k.length * 2 + JSON.stringify(v).length * 2;
        }
      }
      return bytes;
    },
    close(): void {
      tables.clear();
    },
  };
};

export interface IndexedDbOptions {
  readonly factory?: IDBFactory | undefined;
  readonly dbName?: string | undefined;
  readonly version?: number | undefined;
}

/**
 * Creates an IndexedDB-backed WorkspaceDatabase.
 * Falls back to in-memory database gracefully if IndexedDB is unsupported or throws SecurityError.
 */
export const openWorkspaceDatabase = async (
  options: IndexedDbOptions = {},
): Promise<WorkspaceDatabase> => {
  const factory = options.factory ?? (typeof indexedDB !== "undefined" ? indexedDB : undefined);

  if (!factory) {
    return createMemoryWorkspaceDatabase();
  }

  const dbName = options.dbName ?? WORKSPACE_DB_NAME;
  const version = options.version ?? WORKSPACE_DB_VERSION;

  try {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = factory.open(dbName, version);

      req.onupgradeneeded = (event) => {
        const targetDb = req.result;
        applyWorkspaceMigrations(targetDb, event.oldVersion, version);
      };

      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => {
        // Continue, will resolve or error
      };
    });

    return {
      isHealthy: true,
      isReadOnly: false,
      async get<T>(storeName: WorkspaceStoreName, key: IDBValidKey): Promise<T | undefined> {
        return new Promise<T | undefined>((resolve, reject) => {
          const tx = db.transaction(storeName, "readonly");
          const store = tx.objectStore(storeName);
          const req = store.get(key);
          req.onsuccess = () => resolve(req.result as T | undefined);
          req.onerror = () => reject(req.error);
        });
      },
      async put<T>(storeName: WorkspaceStoreName, value: T): Promise<void> {
        return new Promise<void>((resolve, reject) => {
          const tx = db.transaction(storeName, "readwrite");
          const store = tx.objectStore(storeName);
          const req = store.put(value);
          req.onsuccess = () => resolve();
          req.onerror = () => reject(req.error);
        });
      },
      async delete(storeName: WorkspaceStoreName, key: IDBValidKey): Promise<void> {
        return new Promise<void>((resolve, reject) => {
          const tx = db.transaction(storeName, "readwrite");
          const store = tx.objectStore(storeName);
          const req = store.delete(key);
          req.onsuccess = () => resolve();
          req.onerror = () => reject(req.error);
        });
      },
      async getAll<T>(
        storeName: WorkspaceStoreName,
        query?: IDBValidKey | IDBKeyRange | null,
        count?: number,
      ): Promise<readonly T[]> {
        return new Promise<readonly T[]>((resolve, reject) => {
          const tx = db.transaction(storeName, "readonly");
          const store = tx.objectStore(storeName);
          const req =
            query === undefined || query === null
              ? store.getAll(undefined, count)
              : store.getAll(query, count);
          req.onsuccess = () => resolve(req.result as readonly T[]);
          req.onerror = () => reject(req.error);
        });
      },
      async getAllFromIndex<T>(
        storeName: WorkspaceStoreName,
        indexName: string,
        query?: IDBValidKey | IDBKeyRange | null,
        count?: number,
      ): Promise<readonly T[]> {
        return new Promise<readonly T[]>((resolve, reject) => {
          const tx = db.transaction(storeName, "readonly");
          const store = tx.objectStore(storeName);
          const idx = store.index(indexName);
          const req =
            query === undefined || query === null
              ? idx.getAll(undefined, count)
              : idx.getAll(query, count);
          req.onsuccess = () => resolve(req.result as readonly T[]);
          req.onerror = () => reject(req.error);
        });
      },
      async count(storeName: WorkspaceStoreName): Promise<number> {
        return new Promise<number>((resolve, reject) => {
          const tx = db.transaction(storeName, "readonly");
          const store = tx.objectStore(storeName);
          const req = store.count();
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
      },
      async clear(storeName: WorkspaceStoreName): Promise<void> {
        return new Promise<void>((resolve, reject) => {
          const tx = db.transaction(storeName, "readwrite");
          const store = tx.objectStore(storeName);
          const req = store.clear();
          req.onsuccess = () => resolve();
          req.onerror = () => reject(req.error);
        });
      },
      async estimateSize(): Promise<number> {
        if (navigator?.storage?.estimate) {
          try {
            const estimate = await navigator.storage.estimate();
            return estimate.usage ?? 0;
          } catch {}
        }
        return 0;
      },
      close(): void {
        db.close();
      },
    };
  } catch (_err) {
    // If opening IndexedDB failed (e.g. security permissions, private browsing), fallback to memory
    return createMemoryWorkspaceDatabase();
  }
};
