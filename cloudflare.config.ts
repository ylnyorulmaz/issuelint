import { bindings, defineConfig } from "cf/config";

export default defineConfig(({ mode, isPreview }) => {
  // Private production testing is enabled on the protected production Worker.
  // Local development and branch previews remain disabled by default.
  const privateProduction = mode === "production" && !isPreview;

  return {
    worker: {
      name: "issuelint-dev",
      entrypoint: "./worker/index.ts",
      compatibilityDate: "2026-11-20",
      previewUrls: false,
      assets: { notFoundHandling: "single-page-application", runWorkerFirst: ["/api/*"] },
      env: {
        AI: bindings.ai(),
        ASSETS: bindings.assets(),
        ANALYZE_ENABLED: bindings.text(privateProduction ? "true" : "false"),
        PREVIEW_TOKEN: bindings.secret(),
        AI_MODEL: bindings.text("@cf/openai/gpt-oss-120b"),
        FEEDBACK_VERIFIER_MODE: bindings.text(privateProduction ? "on" : "off"),
        SAYGM_API_KEY: bindings.secret(),
      },
      observability: {
        enabled: true,
        redactQueryString: true,
        logs: { enabled: true, persist: true, invocationLogs: true, headSamplingRate: 1 },
        traces: { enabled: true, persist: true, headSamplingRate: 0.25 },
      },
    },
  };
});
