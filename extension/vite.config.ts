import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";

const root = import.meta.dirname;
const src = resolve(root, "src");
const outDir = resolve(root, "dist");

/** Copies manifest.json into dist/, stamping the version from package.json. */
function manifest(): Plugin {
  return {
    name: "issuelint-clipper-manifest",
    generateBundle() {
      const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
      const json = JSON.parse(readFileSync(resolve(root, "manifest.json"), "utf8"));
      json.version = pkg.version;
      this.emitFile({ type: "asset", fileName: "manifest.json", source: JSON.stringify(json, null, 2) });
    },
  };
}

export default defineConfig(({ mode }) => {
  // The content script is injected with chrome.scripting.executeScript({ files }),
  // which requires a single classic script, so it gets its own self-contained IIFE build.
  if (mode === "content") {
    return {
      publicDir: false,
      build: {
        outDir,
        emptyOutDir: false,
        target: "chrome116",
        minify: true,
        sourcemap: false,
        lib: {
          entry: resolve(src, "content.ts"),
          formats: ["iife"],
          name: "IssueLintClipperContent",
          fileName: () => "content.js",
        },
        rollupOptions: { output: { inlineDynamicImports: true } },
      },
    };
  }

  // Side panel page + module service worker.
  return {
    root: src,
    base: "./",
    publicDir: resolve(root, "public"),
    plugins: [manifest()],
    build: {
      outDir,
      emptyOutDir: true,
      target: "chrome116",
      sourcemap: false,
      modulePreload: false,
      rollupOptions: {
        input: {
          sidepanel: resolve(src, "sidepanel.html"),
          background: resolve(src, "background.ts"),
        },
        output: {
          entryFileNames: "[name].js",
          chunkFileNames: "chunks/[name]-[hash].js",
          assetFileNames: "assets/[name]-[hash][extname]",
        },
      },
    },
  };
});
