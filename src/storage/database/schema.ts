/**
 * IndexedDB Schema definition and store names for JobPilot Workspace.
 */

export const WORKSPACE_DB_NAME = "jobpilot_workspace_db";
export const WORKSPACE_DB_VERSION = 1;

export const WORKSPACE_STORES = {
  jobs: "jobs",
  annotations: "annotations",
  pipeline: "pipeline",
  tags: "tags",
  timeline: "timeline",
  interviews: "interviews",
  searchSessions: "searchSessions",
  metadata: "metadata",
} as const;

export type WorkspaceStoreName = (typeof WORKSPACE_STORES)[keyof typeof WORKSPACE_STORES];

export interface IndexDefinition {
  readonly name: string;
  readonly keyPath: string | readonly string[];
  readonly unique?: boolean;
}

export interface StoreDefinition {
  readonly name: WorkspaceStoreName;
  readonly keyPath: string;
  readonly autoIncrement?: boolean;
  readonly indexes: readonly IndexDefinition[];
}

export const WORKSPACE_SCHEMA_V1: readonly StoreDefinition[] = [
  {
    name: WORKSPACE_STORES.jobs,
    keyPath: "id",
    indexes: [
      { name: "companyName", keyPath: "companyName" },
      { name: "title", keyPath: "title" },
      { name: "lastSeenAt", keyPath: "lastSeenAt" },
      { name: "city", keyPath: "city" },
    ],
  },
  {
    name: WORKSPACE_STORES.annotations,
    keyPath: "jobId",
    indexes: [
      { name: "preference", keyPath: "preference" },
      { name: "pinned", keyPath: "pinned" },
      { name: "updatedAt", keyPath: "updatedAt" },
    ],
  },
  {
    name: WORKSPACE_STORES.pipeline,
    keyPath: "jobId",
    indexes: [
      { name: "stage", keyPath: "stage" },
      { name: "updatedAt", keyPath: "updatedAt" },
    ],
  },
  {
    name: WORKSPACE_STORES.tags,
    keyPath: "id",
    indexes: [{ name: "name", keyPath: "name", unique: true }],
  },
  {
    name: WORKSPACE_STORES.timeline,
    keyPath: "id",
    indexes: [
      { name: "jobId", keyPath: "jobId" },
      { name: "timestamp", keyPath: "timestamp" },
    ],
  },
  {
    name: WORKSPACE_STORES.interviews,
    keyPath: "id",
    indexes: [
      { name: "jobId", keyPath: "jobId" },
      { name: "scheduledAt", keyPath: "scheduledAt" },
    ],
  },
  {
    name: WORKSPACE_STORES.searchSessions,
    keyPath: "id",
    indexes: [{ name: "startedAt", keyPath: "startedAt" }],
  },
  {
    name: WORKSPACE_STORES.metadata,
    keyPath: "key",
    indexes: [],
  },
];
