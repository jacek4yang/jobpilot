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
}
