import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import monkey from "vite-plugin-monkey";

/**
 * Build identity, resolved once at config time and injected as compile-time
 * constants.
 *
 * Two properties matter and are both enforced by `scripts/verify-build.ts` and
 * `scripts/verify-diagnostic-build.ts`:
 *
 *  - The commit is read from git, never invented. A plausible-looking but wrong
 *    SHA is worse than an honest `"unknown"`, because support would chase a
 *    revision that was never built.
 *  - The version has a single source (package.json) so `@version`, the in-panel
 *    label and the release workflow cannot drift apart.
 */

export type BuildChannel = "production" | "diagnostic";

/** Channel names as recorded in the artifact and in every exported bundle. */
const CHANNELS: readonly BuildChannel[] = ["production", "diagnostic"];

const isBuildChannel = (value: string | undefined): value is BuildChannel =>
  value !== undefined && (CHANNELS as readonly string[]).includes(value);

/**
 * Resolves the channel from the environment.
 *
 * Anything unrecognised — including a typo such as `JOBPILOT_CHANNEL=diag` —
 * falls back to `production` rather than producing a half-configured build.
 */
export const resolveChannel = (
  raw: string | undefined = process.env["JOBPILOT_CHANNEL"],
): BuildChannel => (isBuildChannel(raw) ? raw : "production");

/**
 * Reads the version from package.json so the userscript `@version`, the
 * in-panel version label and the release workflow can never disagree.
 */
const readVersion = (): string => {
  try {
    const raw = readFileSync(fileURLToPath(new URL("./package.json", import.meta.url)), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
};

const VERSION = readVersion();

/**
 * Reads the current commit.
 *
 * Falls back to the literal `"unknown"` on ANY error: not a git repository, git
 * not installed, a shallow CI checkout without the object, or a non-zero exit.
 * The fallback is deliberately not a fabricated SHA.
 */
const readCommit = (): string => {
  try {
    const output = execSync("git rev-parse HEAD", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      // A hung git process must not hang the build.
      timeout: 10_000,
    }).trim();
    // Guard against a wrapper on PATH echoing something that is not a SHA.
    return /^[0-9a-f]{40}$/.test(output) ? output : "unknown";
  } catch {
    return "unknown";
  }
};

export interface ChannelConfig {
  /** Artifact filename inside `dist/`. */
  readonly fileName: string;
  /** Userscript `@name`; distinct so both channels install side by side. */
  readonly name: string;
  /** Human-readable `@description`. */
  readonly description: string;
  readonly minify: boolean;
}

const CHANNEL_CONFIG: Readonly<Record<BuildChannel, ChannelConfig>> = {
  production: {
    fileName: "jobpilot.user.js",
    name: "JobPilot",
    description:
      "Local-first, rule-driven job application assistant. Assist mode by default; never bypasses CAPTCHA or risk control.",
    minify: true,
  },
  diagnostic: {
    fileName: "jobpilot.diagnostic.user.js",
    name: "JobPilot Diagnostic",
    description:
      "JobPilot diagnostic build: unminified, with verbose structured recording. Assist mode by default; never bypasses CAPTCHA or risk control.",
    // Unminified on purpose: a stack trace from a diagnostic run must point at
    // readable code, which is the entire reason this channel exists.
    minify: false,
  },
};

export const channelConfig = (channel: BuildChannel): ChannelConfig => CHANNEL_CONFIG[channel];

/**
 * The shared Vite configuration.
 *
 * Both channels are built from this one function so safety behaviour — match
 * patterns, grants, timeouts, mode defaults — cannot diverge between them. The
 * only differences are the artifact name and minification.
 */
export function createConfig(channel: BuildChannel = resolveChannel()) {
  const identity = channelConfig(channel);
  const commit = readCommit();
  const buildTime = new Date().toISOString();

  return defineConfig({
    define: {
      __JOBPILOT_VERSION__: JSON.stringify(VERSION),
      __JOBPILOT_COMMIT__: JSON.stringify(commit),
      __JOBPILOT_BUILD_TIME__: JSON.stringify(buildTime),
      __JOBPILOT_CHANNEL__: JSON.stringify(channel),
    },
    plugins: [
      monkey({
        entry: "src/main.ts",
        userscript: {
          name: identity.name,
          namespace: "https://github.com/jobpilot/jobpilot",
          description: identity.description,
          version: VERSION,
          author: "JobPilot contributors",
          license: "MIT",
          // Least privilege: only the two BOSS hosts are matched. Identical in
          // both channels; a diagnostic build is not a reason to widen access.
          match: ["https://www.zhipin.com/*", "https://zhipin.com/*"],
          grant: ["GM_getValue", "GM_setValue", "GM_deleteValue", "GM_registerMenuCommand"],
          "run-at": "document-idle",
          noframes: true,
          /**
           * Build identity, repeated in the metadata block.
           *
           * The four `__JOBPILOT_*__` defines above are the runtime source of
           * truth, but a define that nothing references is tree-shaken away —
           * and a bundle that does not say which commit produced it is not
           * actionable. `$extra` is the plugin's escape hatch for arbitrary
           * metadata lines, so `scripts/verify-diagnostic-build.ts` can prove
           * the artifact carries its own identity.
           *
           * An unrecognised `@` key is legal metadata and is ignored by
           * userscript managers; it grants nothing and matches nothing.
           */
          $extra: [
            ["jobpilot-channel", channel],
            ["jobpilot-commit", commit],
            ["jobpilot-built", buildTime],
          ],
        },
        build: {
          fileName: identity.fileName,
          // Keep everything in one runtime file: no dynamic import chunks.
          cssSideEffects: () => {},
        },
      }),
    ],
    build: {
      target: "es2022",
      // Both channels write to dist/. Vite empties outDir before each build, so
      // building sequentially would delete the sibling artifact and leave a
      // verify step checking a file that is not there — or worse, checking the
      // wrong channel. Emptying is disabled and handled once by the build:all
      // script instead.
      emptyOutDir: false,
      minify: identity.minify ? "esbuild" : false,
      cssCodeSplit: false,
      assetsInlineLimit: 0,
      reportCompressedSize: false,
      // vite-plugin-monkey sets the rollup input to the userscript entry and
      // emits a single file. Overriding rollupOptions here would reintroduce
      // Vite's default index.html entry and split the bundle.
    },
  });
}

export default createConfig();
