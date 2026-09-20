/**
 * Bundle reading and validation.
 *
 * The analyzer trusts nothing: a bundle is untrusted input that may be
 * truncated, hand-edited, or produced by a different format version. Every read
 * is validated, and a problem is reported rather than worked around, because a
 * silently misread bundle would produce a confidently wrong diagnosis.
 */

import { sha256Hex } from "../../src/diagnostics/bundle/hash";
import { readZip } from "../../src/diagnostics/bundle/zip";

export const SUPPORTED_BUNDLE_FORMAT_VERSION = 1;
export const BUNDLE_ROOT = "jobpilot-diagnostic";

export interface BundleManifest {
  readonly bundleFormatVersion: number;
  readonly diagnosticSchemaVersion: number;
  readonly redactionPolicyVersion: number;
  readonly appVersion: string;
  readonly gitCommit: string;
  readonly buildTimestamp: string;
  readonly channel: string;
  readonly schemaVersion: number;
  readonly sessionId: string;
  readonly scenarioId: string | null;
  readonly scenarioName: string | null;
  readonly sessionStatus: string | null;
  readonly createdAt: number;
  readonly files: readonly string[];
  readonly checksums: Readonly<Record<string, string>>;
}

export interface LoadedBundle {
  readonly manifest: BundleManifest;
  readonly files: ReadonlyMap<string, string>;
  readonly warnings: readonly string[];
}

export type BundleLoadResult =
  | { readonly ok: true; readonly bundle: LoadedBundle }
  | { readonly ok: false; readonly error: string };

/** Narrowing helper for JSON.parse output, which is `any` by nature. */
const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const readString = (source: Record<string, unknown>, key: string, fallback: string): string => {
  const value = source[key];
  return typeof value === "string" ? value : fallback;
};

const readNumber = (source: Record<string, unknown>, key: string, fallback: number): number => {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
};

/**
 * Validates the manifest shape.
 *
 * Returns a list of problems rather than throwing, so the analyzer can report
 * every issue at once instead of one per run.
 */
export const validateManifest = (
  raw: unknown,
): { readonly errors: readonly string[]; readonly manifest?: BundleManifest } => {
  const record = asRecord(raw);
  if (record === undefined) return { errors: ["manifest.json is not an object"] };

  const errors: string[] = [];
  const version = readNumber(record, "bundleFormatVersion", -1);

  if (version !== SUPPORTED_BUNDLE_FORMAT_VERSION) {
    // Refusing beats guessing: a newer format may have moved the evidence.
    errors.push(
      `unsupported bundle format version ${version} (this analyzer supports ${SUPPORTED_BUNDLE_FORMAT_VERSION})`,
    );
  }

  const sessionId = record["sessionId"];
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    errors.push("manifest.sessionId is missing or not a string");
  }

  const checksums = asRecord(record["checksums"]);
  if (checksums === undefined) errors.push("manifest.checksums is missing or not an object");

  const files = record["files"];
  if (!Array.isArray(files)) errors.push("manifest.files is missing or not an array");

  if (errors.length > 0) return { errors };

  return {
    errors,
    manifest: {
      bundleFormatVersion: version,
      diagnosticSchemaVersion: readNumber(record, "diagnosticSchemaVersion", 0),
      redactionPolicyVersion: readNumber(record, "redactionPolicyVersion", 0),
      appVersion: readString(record, "appVersion", "unknown"),
      gitCommit: readString(record, "gitCommit", "unknown"),
      buildTimestamp: readString(record, "buildTimestamp", "unknown"),
      channel: readString(record, "channel", "unknown"),
      schemaVersion: readNumber(record, "schemaVersion", 0),
      sessionId: readString(record, "sessionId", ""),
      scenarioId:
        typeof record["scenarioId"] === "string" ? (record["scenarioId"] as string) : null,
      scenarioName:
        typeof record["scenarioName"] === "string" ? (record["scenarioName"] as string) : null,
      sessionStatus:
        typeof record["sessionStatus"] === "string" ? (record["sessionStatus"] as string) : null,
      createdAt: readNumber(record, "createdAt", 0),
      files: (files as unknown[]).filter((entry): entry is string => typeof entry === "string"),
      checksums: Object.fromEntries(
        Object.entries(checksums ?? {}).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      ),
    },
  };
};

/**
 * Loads and verifies a bundle.
 *
 * Checksums are verified before the evidence is used. A bundle whose contents do
 * not match its manifest is reported as failed rather than analysed, because a
 * report built on tampered evidence is worse than no report.
 */
export const loadBundle = (bytes: Uint8Array): BundleLoadResult => {
  let entries: readonly { path: string; content: string }[];
  try {
    entries = readZip(bytes);
  } catch (error) {
    return {
      ok: false,
      error: `could not read the archive: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const files = new Map<string, string>();
  for (const entry of entries) {
    const prefix = `${BUNDLE_ROOT}/`;
    if (!entry.path.startsWith(prefix)) {
      // Unexpected paths are ignored rather than surfaced as evidence.
      continue;
    }
    files.set(entry.path.slice(prefix.length), entry.content);
  }

  const manifestText = files.get("manifest.json");
  if (manifestText === undefined) {
    return { ok: false, error: "bundle has no manifest.json" };
  }

  let parsedManifest: unknown;
  try {
    parsedManifest = JSON.parse(manifestText);
  } catch {
    return { ok: false, error: "manifest.json is not valid JSON" };
  }

  const validated = validateManifest(parsedManifest);
  if (validated.manifest === undefined) {
    return { ok: false, error: `invalid manifest: ${validated.errors.join("; ")}` };
  }

  const warnings: string[] = [...validated.errors];

  // Required-file check. Without this, a bundle missing its evidence files
  // loads cleanly and the analyzer then reports on partial data as if it were
  // complete — the confidence would be unfounded. The event stream in
  // particular must be present, because every finding is derived from it.
  const REQUIRED = [
    "summary.txt",
    "build.json",
    "session.json",
    "events.ndjson",
    "state-transitions.ndjson",
    "config.redacted.json",
  ] as const;
  const missing = REQUIRED.filter((name) => !files.has(name));
  if (missing.length > 0) {
    return {
      ok: false,
      error: `bundle is incomplete; missing: ${missing.join(", ")}`,
    };
  }

  if (!files.has("checksums.json")) {
    // Checksums can verify nothing if they are absent, so an unverifiable
    // bundle is downgraded to a warning rather than trusted silently.
    warnings.push("checksums.json is absent, so file integrity could not be verified");
  }

  for (const [name, expected] of Object.entries(validated.manifest.checksums)) {
    const content = files.get(name);
    if (content === undefined) {
      warnings.push(`checksum recorded for missing file: ${name}`);
      continue;
    }
    const actual = sha256Hex(content);
    if (actual !== expected) {
      // A mismatch means the evidence cannot be trusted, so this is fatal.
      return { ok: false, error: `checksum mismatch for ${name}` };
    }
  }

  return { ok: true, bundle: { manifest: validated.manifest, files, warnings } };
};

/** Parses an NDJSON file into objects, skipping and reporting bad lines. */
export const parseNdjson = (
  content: string | undefined,
): { readonly rows: readonly Record<string, unknown>[]; readonly malformed: number } => {
  if (content === undefined) return { rows: [], malformed: 0 };
  const rows: Record<string, unknown>[] = [];
  let malformed = 0;

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = asRecord(JSON.parse(trimmed));
      if (parsed === undefined) {
        malformed += 1;
        continue;
      }
      rows.push(parsed);
    } catch {
      malformed += 1;
    }
  }

  return { rows, malformed };
};

export { asRecord, readNumber, readString };
