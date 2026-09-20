/**
 * Build verification for the production userscript.
 *
 * Asserts the properties that make the artifact installable and safe to ship.
 * Exits non-zero on any failure so CI cannot publish a broken bundle.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const DIST = join(ROOT, "dist");
const ARTIFACT = join(DIST, "jobpilot.user.js");

/** Grants the adapter actually uses. Anything else is a privilege increase. */
const EXPECTED_GRANTS: readonly string[] = [
  "GM_getValue",
  "GM_setValue",
  "GM_deleteValue",
  "GM_registerMenuCommand",
];

/** Refuse to ship something absurdly large; a single-file bundle should be small. */
const MAX_ARTIFACT_BYTES = 512 * 1024;
const MIN_ARTIFACT_BYTES = 4 * 1024;

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

const sha256 = (buffer: Buffer): string =>
  createHash("sha256").update(buffer).digest("hex");

// 1. Artifact exists ---------------------------------------------------------
let source: string;
try {
  const stats = statSync(ARTIFACT);
  if (!stats.isFile()) {
    fail("artifact-exists", `${ARTIFACT} is not a regular file`);
    process.exit(1);
  }
  source = readFileSync(ARTIFACT, "utf8");
} catch {
  console.error(`FAIL artifact-exists: ${ARTIFACT} does not exist. Run \`pnpm build\` first.`);
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

  // 4. Version matches package.json -----------------------------------------
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

  // 5. Grants are least-privilege -------------------------------------------
  const grants = [...metadata.matchAll(/^\/\/\s*@grant\s+(\S+)\s*$/gm)].map((match) => match[1]);
  const unexpected = grants.filter(
    (grant) => grant !== undefined && !EXPECTED_GRANTS.includes(grant),
  );
  if (unexpected.length > 0) {
    fail("unexpected-grant", `unexpected @grant entries: ${unexpected.join(", ")}`);
  } else {
    notes.push(`grants: ${grants.join(", ") || "none"}`);
  }

  // 6. Match patterns are limited to supported hosts -------------------------
  // Accepts both the apex host and its subdomains, e.g. `https://zhipin.com/*`
  // and `https://www.zhipin.com/*`.
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
  }

  // 7. No remote code execution surface -------------------------------------
  const dangerous = ["@require", "@resource", "eval("];
  for (const needle of dangerous) {
    if (needle === "eval(" ? /[^.\w]eval\s*\(/.test(source) : metadata.includes(needle)) {
      fail("no-remote-code", `artifact contains "${needle}"`);
    }
  }
}

// 8. Single runtime file -----------------------------------------------------
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
    // Source maps are not runtime dependencies.
    !entry.endsWith(".map"),
);

if (runtimeFiles.length !== 1) {
  fail(
    "single-runtime-file",
    `expected exactly one runtime file, found ${runtimeFiles.length}: ${runtimeFiles.join(", ")}`,
  );
} else if (runtimeFiles[0] !== "jobpilot.user.js") {
  fail("single-runtime-file", `expected dist/jobpilot.user.js, found ${runtimeFiles[0]}`);
} else {
  notes.push("exactly one runtime file: dist/jobpilot.user.js");
}

// 9. No external CSS dependency ---------------------------------------------
// A stylesheet <link> or @import would break the "one file" guarantee.
if (/<link[^>]+rel=["']?stylesheet/i.test(source) || /@import\s+url\(/i.test(source)) {
  fail("no-external-css", "artifact references an external stylesheet");
}

// 10. No unresolved import statements ---------------------------------------
// Bundled output must not contain bare module specifiers.
if (/^\s*import\s+[^"']+from\s+["'][^."'/][^"']*["']/m.test(source)) {
  fail("no-unresolved-import", "artifact still contains a bare module import");
}
if (/^\s*export\s+/m.test(source)) {
  fail("no-unresolved-import", "artifact still contains a top-level export statement");
}

// 11. Artifact size ----------------------------------------------------------
if (bytes > MAX_ARTIFACT_BYTES) {
  fail("artifact-size", `artifact is ${bytes} bytes, over the ${MAX_ARTIFACT_BYTES} byte budget`);
}
if (bytes < MIN_ARTIFACT_BYTES) {
  fail("artifact-size", `artifact is only ${bytes} bytes; the build looks incomplete`);
}

// 12. Expected runtime markers ----------------------------------------------
// Cheap sanity check that the bundle is actually JobPilot and not an empty stub.
if (!source.includes("JobPilot")) {
  fail("content-sanity", "artifact does not mention JobPilot");
}
if (!source.includes("jobpilot-")) {
  fail("content-sanity", "artifact does not contain the scoped UI class prefix");
}

// Report ---------------------------------------------------------------------
const digest = sha256(Buffer.from(source, "utf8"));

console.log("JobPilot build verification");
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

console.log("\nAll build checks passed.");

function statIsDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
