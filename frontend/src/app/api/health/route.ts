import { BACKEND_ROUTES, proxyBackend, resolveBackendBaseUrl } from "@/lib/backend/proxy";
import { buildIntegrity } from "@/lib/backend/build-integrity";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Report backend health and readiness to the browser.
 *
 * The browser needs one answer to "can I ask a question right now?", but the backend
 * answers two separate questions: liveness (is the process up) and readiness (is the
 * corpus readable and the session store writable). Both are checked here and collapsed
 * into a single status the header can render.
 *
 * `ready` means both passed. `degraded` means the process is alive but cannot currently
 * serve a run — usually an unreadable corpus or an unwritable database, which is worth
 * distinguishing because it is an operator problem rather than an outage. `down` means the
 * process could not be reached at all.
 *
 * Neither upstream check involves the model, so a provider outage never shows here as a
 * dead backend.
 */
export async function GET(request: Request): Promise<Response> {
  // Readiness first, and alone when it passes: a backend that is ready is alive by
  // definition, so the liveness probe would only confirm what the answer already implies.
  // Asking both every time doubled the upstream traffic of the most frequent request the
  // gateway makes -- one browser tab produced hundreds of probes an hour, all of them
  // reporting the same "ready".
  const readiness = await safeProbe(request, BACKEND_ROUTES.readiness());

  // Only a failure needs the second probe, and only to say which failure it is: a live
  // process with an unreadable corpus is an operator's problem, an unreachable one is an
  // outage, and the two are acted on differently.
  const liveness = readiness.ok
    ? { ok: true }
    : await safeProbe(request, BACKEND_ROUTES.health());

  const frontendReady = await buildIntegrity();
  const status = readiness.ok && frontendReady ? "ready" : liveness.ok ? "degraded" : "down";

  return Response.json(
    {
      status,
      checks: {
        liveness: liveness.ok ? "ok" : "failed",
        readiness: readiness.ok ? "ok" : "failed",
        frontend: frontendReady ? "ok" : "failed",
      },
      /** Corpus artifact count, when the backend reported one. Display only. */
      corpusFiles: readiness.corpusFiles ?? null,
      checkedAt: new Date().toISOString(),
    },
    { headers: { "cache-control": "no-store" } },
  );
}

interface ProbeResult {
  readonly ok: boolean;
  readonly corpusFiles?: number;
}

/**
 * Probe one backend endpoint without letting a failure propagate.
 *
 * A health probe that throws is useless: the point is to report the outcome, including
 * when the outcome is "unreachable".
 */
async function safeProbe(request: Request, path: string): Promise<ProbeResult> {
  try {
    // A probe is a fresh GET, not a forward of the browser request, so the browser cannot
    // influence what is asked upstream.
    const probe = new Request(new URL(path, resolveBackendBaseUrl()), {
      method: "GET",
      signal: request.signal,
    });
    const response = await proxyBackend(probe, path, { timeoutMs: 4000 });
    if (!response.ok) {
      return { ok: false };
    }
    const body: unknown = await response.json().catch(() => null);
    const corpusFiles =
      typeof body === "object" && body !== null && "corpus_files" in body
        ? (body as { corpus_files: unknown }).corpus_files
        : undefined;
    return typeof corpusFiles === "number" ? { ok: true, corpusFiles } : { ok: true };
  } catch {
    return { ok: false };
  }
}
