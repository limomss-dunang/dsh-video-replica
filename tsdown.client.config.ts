import { defineConfig } from "tsdown";

/**
 * Client-half build: the browser bundle DSH loads via `./client` (lib/client.js).
 *
 * The DSH web shell loads client bundles through `window.__ModuleLoader__.load`,
 * which hands a CommonJS `require` into a factory. So the client is built as
 * CJS (externals become `require(...)`), wrapped in banner/footer that shape the
 * `__ModuleLoader__` contract. The output extension is pinned to `.js` via
 * outExtensions so it matches package.json `exports["./client"]`.
 *
 * React / react-dom / scheduler come from the browser module table.
 */

const BUNDLE_ID = "dsh-video-replica";

const banner = `window.__ModuleLoader__.load({
	id: "${BUNDLE_ID}",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });`;

const footer = `		return module.exports;
	}
});`;

export default defineConfig({
  entry: {
    client: "src/client/index.tsx",
  },
  outDir: "lib",
  format: ["cjs"],
  fixedExtension: false,
  outExtensions: () => ({ js: ".js" }),
  banner: { js: banner },
  footer: { js: footer },
  clean: false,
  deps: {
    neverBundle: [/^@deepseek-ai\//, /^react(-dom)?($|\/)/, /^scheduler($|\/)/],
  },
});
