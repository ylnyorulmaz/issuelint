import { bindings, defineConfig } from "cf/config";

export default defineConfig({
  worker: {
    name: "issuelint-dev",
    entrypoint: "./worker/index.ts",
    compatibilityDate: "2026-11-20",
    assets: { notFoundHandling: "single-page-application", runWorkerFirst: ["/api/*"] },
    env: {
      AI: bindings.ai(),
      ASSETS: bindings.assets(),
      ANALYZE_ENABLED: bindings.text("false"),
      PREVIEW_TOKEN: bindings.secret(),
      AI_MODEL: bindings.text("@cf/openai/gpt-oss-120b"),
      FEEDBACK_VERIFIER_MODE: bindings.text("off"),
      SAYGM_API_KEY: bindings.secret(),
    },
    observability: { enabled: true, traces: { enabled: true } },
  },
});
