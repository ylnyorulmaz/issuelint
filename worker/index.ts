/**
 * IssueLint Iteration 1 transport stub.
 * NO user input is inspected or persisted; NO AI inference is executed.
 */
interface WorkerEnv {
  /** Workers AI binding. Iteration 2 will use generated Cloudflare types. */
  AI?: unknown;
  ASSETS: { fetch(request: Request): Promise<Response> };
}

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...extraHeaders,
    },
  });
}

function methodNotAllowed(allowed: string): Response {
  return json({ error: "METHOD_NOT_ALLOWED", message: `Use ${allowed} for this endpoint.` }, 405, {
    Allow: allowed,
  });
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === "/api/health") {
      if (request.method !== "GET") return methodNotAllowed("GET");

      return json({
        status: "ok",
        service: "issuelint",
        iteration: 1,
        aiBindingConfigured: env.AI != null,
      });
    }

    if (pathname === "/api/analyze") {
      if (request.method !== "POST") return methodNotAllowed("POST");

      const contentType = request.headers.get("content-type") ?? "";
      if (!/^application\/json(?:\s*;|\s*$)/i.test(contentType)) {
        return json({ error: "UNSUPPORTED_MEDIA_TYPE", message: "Send application/json." }, 415);
      }

      // Deliberately do not read, log, or echo the body during transport testing.
      return json({
        mode: "stub",
        analyzed: false,
        aiBindingConfigured: env.AI != null,
        message: "Transport test passed. No AI inference or task analysis was performed.",
        findings: [],
        suggestedRewrite: null,
      });
    }

    if (pathname.startsWith("/api/")) {
      return json({ error: "NOT_FOUND", message: "Unknown API endpoint." }, 404);
    }

    // Static files are usually served without invoking this Worker at all.
    return env.ASSETS.fetch(request);
  },
};
