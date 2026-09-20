/**
 * Build verification for the diagnostic userscript.
 *
 * The diagnostic channel is a wider-privilege artefact in one narrow sense: it
 * records far more, and it is unminified. It must therefore never be a wider
 * privilege in the sense that actually matters — it must request exactly the
 * same grants, match exactly the same hosts, and carry no remote-loading
 * surface. This script exists so that an accidental widening fails CI rather
 * than shipping.
 *
 * Exits non-zero on any failure.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { newestSourceMtime } from "./lib/freshness";

const ROOT = resolve(import.meta.dirname, "..");
const DIST = join(ROOT, "dist");
const ARTIFACT = join(DIST, "jobpilot.diagnostic.user.js");

/** Grants the adapter actually uses. Identical to the production channel. */
const EXPECTED_GRANTS: readonly string[] = [
  "GM_getValue",
  "GM_setValue",
  "GM_deleteValue",
  "GM_registerMenuCommand",
];

/** The diagnostic name, so it installs side by side with production. */
const EXPECTED_NAME = "JobPilot Diagnostic";

/**
 * Diagnostic builds are larger: unminified, with verbose recording.
 *
 * Generous but real — it catches a runaway dependency or an accidentally
 * inlined asset, which is the failure this bound is for.
 */
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
const MIN_ARTIFACT_BYTES = 8 * 1024;

/** `unknown` is the honest fallback when git was unavailable at build time. */
const UNKNOWN_COMMIT = "unknown";
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

interface Failure {
  readonly check: string;
  readonly detail: string;
}

const failures: Failure[] = [];
const notes: string[] = [];

const fail = (check: string, detail: string): void => {
  failures.push({ check, detail });
};

const readPackageVersion = (): string => {
  const raw = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    version?: unknown;
  };
  return typeof raw.version === "string" ? raw.version : "unknown";
};

const sha256 = (buffer: Buffer): string => createHash("sha256").update(buffer).digest("hex");

const statIsDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

// 1. Artifact exists ---------------------------------------------------------
let source: string;
try {
  const stats = statSync(ARTIFACT);
  if (!stats.isFile()) {
    console.error(`FAIL artifact-exists: ${ARTIFACT} is not a regular file`);
    process.exit(1);
  }
  source = readFileSync(ARTIFACT, "utf8");
} catch {
  console.error(
    `FAIL artifact-exists: ${ARTIFACT} does not exist. Run \`pnpm build:diagnostic\` first.`,
  );
  process.exit(1);
}

const bytes = Buffer.byteLength(source, "utf8");

// 2. Metadata block ----------------------------------------------------------
const metadataMatch = /\/\/ ==UserScript==([\s\S]*?)\/\/ ==\/UserScript==/.exec(source);
if (metadataMatch === null) {
  fail("metadata", "no ==UserScript== ... ==/UserScript== block found");
}

const metadata = metadataMatch?.[1] ?? "";

const readMeta = (field: string): string | undefined => {
  const match = new RegExp(`^//\\s*@${field}\\s+(.+)$`, "m").exec(metadata);
  return match?.[1]?.trim();
};

if (metadata !== "") {
  // 3. Required fields -------------------------------------------------------
  for (const field of ["name", "namespace", "version", "description", "match", "grant"]) {
    if (readMeta(field) === undefined) {
      fail("metadata-required-field", `missing @${field}`);
    }
  }

  // 4. @version matches package.json ----------------------------------------
  const packageVersion = readPackageVersion();
  const metaVersion = readMeta("version");
  if (metaVersion !== packageVersion) {
    fail(
      "version-mismatch",
      `userscript @version is "${metaVersion}" but package.json is "${packageVersion}"`,
    );
  } else {
    notes.push(`version ${metaVersion} matches package.json`);
  }

  // 5. @name is the diagnostic name -----------------------------------------
  const metaName = readMeta("name");
  if (metaName !== EXPECTED_NAME) {
    fail("name-mismatch", `userscript @name is "${metaName}", expected "${EXPECTED_NAME}"`);
  } else {
    notes.push(`name is "${EXPECTED_NAME}" (installs alongside production)`);
  }

  // 6. Grants are EXACTLY the allowed set -----------------------------------
  // Set equality, not a subset test: a missing grant breaks the artifact and an
  // extra grant is a privilege increase. Both are failures.
  const grants = [...metadata.matchAll(/^\/\/\s*@grant\s+(\S+)\s*$/gm)].map((match) => match[1]);
  const grantSet = new Set(grants.filter((grant): grant is string => grant !== undefined));
  const unexpected = [...grantSet].filter((grant) => !EXPECTED_GRANTS.includes(grant));
  const missing = EXPECTED_GRANTS.filter((grant) => !grantSet.has(grant));
  if (unexpected.length > 0) {
    fail("unexpected-grant", `unexpected @grant entries: ${unexpected.join(", ")}`);
  }
  if (missing.length > 0) {
    fail("missing-grant", `missing @grant entries: ${missing.join(", ")}`);
  }
  if (unexpected.length === 0 && missing.length === 0) {
    notes.push(`grants are exactly: ${EXPECTED_GRANTS.join(", ")}`);
  }

  // 7. Match patterns are limited to the BOSS hosts -------------------------
  const matches = [...metadata.matchAll(/^\/\/\s*@match\s+(\S+)\s*$/gm)].map(
    (match) => match[1] ?? "",
  );
  const allowedMatch = /^https:\/\/(?:[a-z0-9-]+\.)*zhipin\.com\/\*$/;
  const badMatch = matches.find((entry) => !allowedMatch.test(entry));
  if (badMatch !== undefined) {
    fail("unexpected-match", `@match "${badMatch}" is outside the supported BOSS hosts`);
  }
  if (matches.length === 0) {
    fail("missing-match", "no @match pattern present");
  } else if (badMatch === undefined) {
    notes.push(`@match limited to BOSS hosts: ${matches.join(", ")}`);
  }

  // 8. No remote code execution surface -------------------------------------
  const dangerous = ["@require", "@resource"];
  for (const needle of dangerous) {
    if (metadata.includes(needle)) {
      fail("no-remote-code", `metadata contains "${needle}"`);
    }
  }

  // 9. Embedded build identity ----------------------------------------------
  // The channel marker must be present, and must say `diagnostic`. A bundle
  // whose identity is missing cannot be attributed to a source revision.
  const channelMarker = readMeta("jobpilot-channel");
  if (channelMarker === undefined) {
    fail("build-identity", "no @jobpilot-channel marker in the metadata block");
  } else if (channelMarker !== "diagnostic") {
    fail("build-identity", `@jobpilot-channel is "${channelMarker}", expected "diagnostic"`);
  } else {
    notes.push("channel marker: diagnostic");
  }

  if (metaVersion === undefined || !source.includes(metaVersion)) {
    fail("build-identity", "the package version does not appear anywhere in the artifact");
  }

  // 10. The commit is a real SHA or an honest `unknown` ----------------------
  // This is the check that catches a fabricated identity.
  const commit = readMeta("jobpilot-commit");
  if (commit === undefined) {
    fail("build-identity", "no @jobpilot-commit marker in the metadata block");
  } else if (commit !== UNKNOWN_COMMIT && !COMMIT_PATTERN.test(commit)) {
    fail(
      "git-commit",
      `@jobpilot-commit is "${commit}"; expected a 40-character hex SHA or "${UNKNOWN_COMMIT}"`,
    );
  } else {
    notes.push(`commit: ${commit}`);
  }

  // 11. Build timestamp ------------------------------------------------------
  const built = readMeta("jobpilot-built");
  if (built === undefined) {
    fail("build-identity", "no @jobpilot-built marker in the metadata block");
  } else if (Number.isNaN(Date.parse(built))) {
    fail("build-identity", `@jobpilot-built is not a parseable timestamp: "${built}"`);
  } else {
    // Freshness matters more for the diagnostic channel than for production:
    // a stale diagnostic artifact means the operator tests code that is not
    // the code under review, and every bundle they export is then misleading.
    const newestSource = newestSourceMtime(join(ROOT, "src"));
    if (newestSource !== undefined && Date.parse(built) < newestSource) {
      fail(
        "artifact-freshness",
        `diagnostic artifact was built at ${built}, before the newest source change at ${new Date(newestSource).toISOString()}. Re-run \`pnpm build:diagnostic\`.`,
      );
    } else {
      notes.push(`build timestamp: ${built}`);
    }
  }
}

// 12. Single diagnostic runtime file -----------------------------------------
let distEntries: string[] = [];
try {
  distEntries = readdirSync(DIST, { recursive: true, encoding: "utf8" }).map((entry) =>
    entry.split("\\").join("/"),
  );
} catch {
  fail("dist-readable", `${DIST} could not be read`);
}

const runtimeFiles = distEntries.filter(
  (entry) =>
    !statIsDirectory(join(DIST, entry)) &&
    /\.(js|mjs|cjs|css)$/.test(entry) &&
    // Source maps and the update-check stub are not runtime dependencies.
    !entry.endsWith(".map") &&
    !entry.endsWith(".meta.js"),
);

// When only the diagnostic channel has been built, dist holds exactly one file.
// When both channels are present (the `check` script builds both), the
// diagnostic artifact must be one of exactly two.
const diagnosticRuntimeFiles = runtimeFiles.filter((entry) => entry.includes("diagnostic"));
if (diagnosticRuntimeFiles.length !== 1) {
  fail(
    "single-runtime-file",
    `expected exactly one diagnostic runtime file, found ${diagnosticRuntimeFiles.length}: ${diagnosticRuntimeFiles.join(", ")}`,
  );
} else if (diagnosticRuntimeFiles[0] !== "jobpilot.diagnostic.user.js") {
  fail(
    "single-runtime-file",
    `expected dist/jobpilot.diagnostic.user.js, found ${diagnosticRuntimeFiles[0]}`,
  );
} else {
  notes.push("exactly one diagnostic runtime file: dist/jobpilot.diagnostic.user.js");
}

// 13. No external CSS dependency ---------------------------------------------
if (/<link[^>]+rel=["']?stylesheet/i.test(source) || /@import\s+url\(/i.test(source)) {
  fail("no-external-css", "artifact references an external stylesheet");
}

// 14. No unresolved import statements ----------------------------------------
if (/^\s*import\s+[^"']+from\s+["'][^."'/][^"']*["']/m.test(source)) {
  fail("no-unresolved-import", "artifact still contains a bare module import");
}
if (/^\s*export\s+/m.test(source)) {
  fail("no-unresolved-import", "artifact still contains a top-level export statement");
}

// 15. Artifact size ----------------------------------------------------------
if (bytes > MAX_ARTIFACT_BYTES) {
  fail("artifact-size", `artifact is ${bytes} bytes, over the ${MAX_ARTIFACT_BYTES} byte budget`);
}
if (bytes < MIN_ARTIFACT_BYTES) {
  fail("artifact-size", `artifact is only ${bytes} bytes; the build looks incomplete`);
}

// 16. Expected runtime markers ------------------------------------------------
if (!source.includes("JobPilot")) {
  fail("content-sanity", "artifact does not mention JobPilot");
}
if (!source.includes("jobpilot-")) {
  fail("content-sanity", "artifact does not contain the scoped UI class prefix");
}

// Report ---------------------------------------------------------------------
const digest = sha256(Buffer.from(source, "utf8"));

console.log("JobPilot diagnostic build verification");
console.log(`  artifact : ${relative(ROOT, ARTIFACT).split("\\").join("/")}`);
console.log(`  size     : ${bytes} bytes (${(bytes / 1024).toFixed(1)} KiB)`);
console.log(`  sha256   : ${digest}`);
for (const note of notes) console.log(`  ok       : ${note}`);

if (failures.length > 0) {
  console.error("\nFAILED:");
  for (const failure of failures) {
    console.error(`  [${failure.check}] ${failure.detail}`);
  }
  console.error(`\n${failures.length} check(s) failed.`);
  process.exit(1);
}

console.log("\nAll diagnostic build checks passed.");
