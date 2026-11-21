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
      assets: { notFoundHandling: "single-page-application", runWorkerFirst: ["/api/*", "/admin", "/admin/*"] },
      env: {
        AI: bindings.ai(),
        ASSETS: bindings.assets(),
        ANALYZE_ENABLED: bindings.text(privateProduction ? "true" : "false"),
        PREVIEW_TOKEN: bindings.secret(),
        // Login requires a separate admin identity; do not reuse PREVIEW_TOKEN.
        // Secrets are provisioned in Cloudflare, never committed to Git.
        ...(privateProduction ? {
          ADMIN_USERNAME: bindings.secret(),
          ADMIN_PASSWORD_HASH: bindings.secret(),
          ADMIN_SESSION_SECRET: bindings.secret(),
          ADMIN_LOGIN_RATE_LIMIT: bindings.rateLimit({
            namespace: "20261122", simple: { limit: 5, period: 60 },
          }),
        } : {}),
        AI_MODEL: bindings.text("@cf/openai/gpt-oss-120b"),
        FEEDBACK_VERIFIER_MODE: bindings.text(privateProduction ? "on" : "off"),
        SAYGM_API_KEY: bindings.secret(),
        // Production Gemini key is now provisioned in Cloudflare secrets.
        // Branch previews do not require this secret and keep AI disabled.
        ...(privateProduction ? { GEMINI_API_KEY: bindings.secret() } : {}),
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
