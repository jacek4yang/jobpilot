/**
 * Build runner.
 *
 * Sets the channel environment variable and invokes Vite. Exists so
 * `pnpm build:diagnostic` works identically on Windows and POSIX without
 * adding a cross-environment dependency for a single variable.
 *
 * Both channels write into `dist/`, and Vite would otherwise empty that
 * directory before each build — deleting the sibling artifact. Only the first
 * build in a sequence may clean, which is what the `--clean` flag expresses.
 */
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";

const args = process.argv.slice(2);
const channel = args.find((arg) => !arg.startsWith("--")) ?? "production";
const shouldClean = args.includes("--clean");

if (channel !== "production" && channel !== "diagnostic") {
  console.error(`unknown build channel: ${channel}`);
  process.exit(1);
}

if (shouldClean) {
  // Done explicitly rather than by Vite, so a second build cannot silently
  // remove the first one's output.
  rmSync("dist", { recursive: true, force: true });
}

const result = spawnSync("npx", ["vite", "build"], {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, JOBPILOT_CHANNEL: channel },
});

process.exit(result.status ?? 1);
