import { bindings, defineConfig } from "cf/config";

/**
 * Development Worker. AI access stays disabled by default and requires a
 * server-side secret. This is NOT the public, rate-limited beta.
 */
export default defineConfig({
  worker: {
    name: "issuelint-dev",
    entrypoint: "./worker/index.ts",
    compatibilityDate: "2026-11-20",
    assets: {
      notFoundHandling: "single-page-application",
      runWorkerFirst: ["/api/*"],
    },
    env: {
      AI: bindings.ai(),
      ASSETS: bindings.assets(),
      ANALYZE_ENABLED: bindings.text("false"),
      PREVIEW_TOKEN: bindings.secret(),
      AI_MODEL: bindings.text("@cf/google/gemma-4-26b-a4b-it"),
    },
    observability: {
      enabled: true,
      traces: { enabled: true },
    },
  },
});
