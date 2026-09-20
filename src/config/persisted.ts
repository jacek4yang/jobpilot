/**
 * The shape of the single document JobPilot keeps under one storage key.
 *
 * Every field is `unknown` on the way in: this interface describes the *trusted*
 * form produced by `migratePersistedRoot`, not the bytes that come back from
 * `Storage.get`. Validation happens in `./validate` and `./migrations`; the
 * repository layer only ever sees a `PersistedRoot` after both have run.
 */

export interface PersistedRoot {
  /** Always {@link CURRENT_SCHEMA_VERSION} once migrated. */
  readonly schemaVersion: number;
  /** A validated `JobPilotConfig`. */
  readonly config: unknown;
  /**
   * Serialised application history.
   *
   * Deliberately `unknown`: the shape is owned by the application repository,
   * and keeping it untyped here means a migration cannot accidentally rewrite
   * records it does not understand.
   */
  readonly applications: unknown;
  /** Serialised statistics. Same reasoning as `applications`. */
  readonly statistics: unknown;
  /**
   * The in-flight communication transaction, when one exists.
   *
   * This is the record that makes "never send twice" survive a reload. The
   * runner stamps the point of no return before clicking, and the adapter
   * stamps `clickDispatched` when it actually clicks; both must outlive the
   * page, or a reload between them would permit a second send.
   *
   * `undefined` when no transaction is in flight. Same untyped reasoning as
   * `applications`: the shape is owned by the domain.
   */
  readonly pendingIntent?: unknown;
}
