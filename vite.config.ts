import { defineConfig } from "vite";
import monkey from "vite-plugin-monkey";

export default defineConfig({
  plugins: [
    monkey({
      entry: "src/main.ts",
      userscript: {
        name: "JobPilot",
        namespace: "https://github.com/jobpilot/jobpilot",
        description:
          "Local-first, rule-driven job application assistant. Assistant mode by default; never bypasses CAPTCHA or risk control.",
        version: process.env.JOBPILOT_VERSION ?? "0.1.0",
        author: "JobPilot contributors",
        license: "MIT",
        match: ["https://www.zhipin.com/*", "https://zhipin.com/*"],
        grant: ["GM_getValue", "GM_setValue", "GM_deleteValue", "GM_registerMenuCommand"],
        "run-at": "document-idle",
        noframes: true,
        icon: "https://www.google.com/s2/favicons?sz=64&domain=zhipin.com",
        connect: [],
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
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
});
