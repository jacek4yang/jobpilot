#!/usr/bin/env tsx
/**
 * Live-test artifact preparation.
 *
 *   pnpm tsx scripts/prepare-live-artifact.ts <SCENARIO_ID>
 *
 * Copies the built diagnostic userscript into `artifacts/live-test/<ID>/` with a
 * `MANIFEST.txt` recording the exact build.
 *
 * The manifest exists for one reason: the operator must be able to confirm that
 * the script they install came from the commit the agent analysed. A handoff
 * that names a commit but ships a different artifact would make every bundle
 * returned from it unattributable, so this script FAILS when the artifact's
 * embedded commit disagrees with `git rev-parse HEAD`.
 */
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ARTIFACT = "dist/jobpilot.diagnostic.user.js";

const scenarioId = process.argv[2];
if (scenarioId === undefined || !/^[A-Za-z0-9_-]+$/.test(scenarioId)) {
  process.stderr.write("usage: prepare-live-artifact.ts <SCENARIO_ID>\n");
  process.stderr.write("  SCENARIO_ID must be alphanumeric, dash or underscore (e.g. T00)\n");
  process.exit(1);
}

/** Reads a `@field` value from the userscript metadata block. */
const readMeta = (source: string, field: string): string => {
  const block = /\/\/ ==UserScript==([\s\S]*?)\/\/ ==\/UserScript==/.exec(source);
  if (block?.[1] === undefined) return "unknown";
  const match = new RegExp(`^//\\s*@${field}\\s+(.+)$`, "m").exec(block[1]);
  return match?.[1]?.trim() ?? "unknown";
};

const bytes = readFileSync(ARTIFACT);
const source = bytes.toString("utf8");

const gitCommit = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
const embeddedCommit = readMeta(source, "jobpilot-commit");
const version = readMeta(source, "version");
const channel = readMeta(source, "jobpilot-channel");
const built = readMeta(source, "jobpilot-built");
const sha256 = createHash("sha256").update(bytes).digest("hex");

if (channel !== "diagnostic") {
  process.stderr.write(
    `FAIL: ${ARTIFACT} has channel "${channel}", expected "diagnostic". Run \`pnpm build:diagnostic\`.\n`,
  );
  process.exit(1);
}

// The load-bearing check. An artifact built from a different commit makes every
// bundle returned from it unattributable.
if (embeddedCommit !== gitCommit) {
  process.stderr.write(
    `FAIL: artifact was built from ${embeddedCommit} but HEAD is ${gitCommit}.\n` +
      `      Re-run \`pnpm build:diagnostic\` before preparing the artifact.\n`,
  );
  process.exit(1);
}

const directory = join("artifacts", "live-test", scenarioId);
mkdirSync(directory, { recursive: true });
copyFileSync(ARTIFACT, join(directory, "jobpilot.diagnostic.user.js"));

writeFileSync(
  join(directory, "MANIFEST.txt"),
  `JobPilot live-test artifact
===========================

scenario:                  ${scenarioId}
version:                   ${version}
git commit (full):         ${gitCommit}
git commit (embedded):     ${embeddedCommit}
channel:                   ${channel}
build timestamp:           ${built}
diagnostic schema version: 1
sha256:                    ${sha256}
bytes:                     ${bytes.length}

The embedded commit equals the git commit above; the preparation script
refuses to emit this file when they disagree. If they differ when you read
this, the artifact has been replaced.
`,
  "utf8",
);

process.stdout.write(`JobPilot live-test artifact ready\n`);
process.stdout.write(`  scenario : ${scenarioId}\n`);
process.stdout.write(`  commit   : ${gitCommit}\n`);
process.stdout.write(`  version  : ${version} (${channel})\n`);
process.stdout.write(`  sha256   : ${sha256}\n`);
process.stdout.write(`  artifact : ${join(directory, "jobpilot.diagnostic.user.js")}\n`);
process.stdout.write(`  manifest : ${join(directory, "MANIFEST.txt")}\n`);
