import { defineConfig } from "tsdown";

/**
 * Host-half build: the Cordis plugin bundle DSH loads via `main` (lib/index.js).
 * ESM format; the client half is built separately by tsdown.client.config.ts.
 *
 * 宿主 API（ctx.webServer / ctx.systemPrompt / ctx.tools …）由 DSH 运行时提供，
 * 构建期不外置任何第三方运行时依赖 —— 本插件只用 node 内置模块 + 原生 fetch。
 */
export default defineConfig({
  entry: {
    index: "src/host/index.ts",
  },
  outDir: "lib",
  format: ["esm"],
  fixedExtension: false,
  dts: false,
  clean: false,
  deps: {
    neverBundle: [/^@deepseek-ai\//],
  },
});
