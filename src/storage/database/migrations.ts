/**
 * Schema migrations for IndexedDB Workspace database.
 *
 * Invariant: Never deletes or corrupts user data.
 * Upgrades object stores and indexes monotonically.
 */

import { WORKSPACE_SCHEMA_V1 } from "./schema";

export const applyWorkspaceMigrations = (
  db: IDBDatabase,
  oldVersion: number,
  newVersion: number,
): void => {
  if (oldVersion < 1 && newVersion >= 1) {
    for (const storeDef of WORKSPACE_SCHEMA_V1) {
      if (!db.objectStoreNames.contains(storeDef.name)) {
        const store = db.createObjectStore(storeDef.name, {
          keyPath: storeDef.keyPath,
          autoIncrement: storeDef.autoIncrement ?? false,
        });

        for (const idx of storeDef.indexes) {
          if (!store.indexNames.contains(idx.name)) {
            store.createIndex(idx.name, idx.keyPath, {
              unique: idx.unique ?? false,
            });
          }
        }
      }
    }
  }
};
