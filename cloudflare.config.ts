import { bindings, defineConfig } from "cf/config";

/**
 * Iteration 1: isolated development Worker, not the production domain.
 * The Cloudflare Vite plugin supplies the Vite build's static assets.
 * Only /api/* routes run Worker code first; frontend assets are served directly.
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
    },
    observability: {
      enabled: true,
      traces: { enabled: true },
    },
  },
});
