import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import monkey from "vite-plugin-monkey";

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

export default defineConfig({
  define: {
    __JOBPILOT_VERSION__: JSON.stringify(VERSION),
  },
  plugins: [
    monkey({
      entry: "src/main.ts",
      userscript: {
        name: "JobPilot",
        namespace: "https://github.com/jobpilot/jobpilot",
        description:
          "Local-first, rule-driven job application assistant. Assist mode by default; never bypasses CAPTCHA or risk control.",
        version: VERSION,
        author: "JobPilot contributors",
        license: "MIT",
        // Least privilege: only the two BOSS hosts are matched.
        match: ["https://www.zhipin.com/*", "https://zhipin.com/*"],
        grant: ["GM_getValue", "GM_setValue", "GM_deleteValue", "GM_registerMenuCommand"],
        "run-at": "document-idle",
        noframes: true,
      },
      build: {
        fileName: "jobpilot.user.js",
        // Keep everything in one runtime file: no dynamic import chunks.
        cssSideEffects: () => {},
      },
    }),
  ],
  build: {
    target: "es2022",
    minify: "esbuild",
    cssCodeSplit: false,
    assetsInlineLimit: 0,
    reportCompressedSize: false,
    // vite-plugin-monkey sets the rollup input to the userscript entry and
    // emits a single file. Overriding rollupOptions here would reintroduce
    // Vite's default index.html entry and split the bundle.
  },
});
