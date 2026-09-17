import { BACKEND_ROUTES, proxySessionRequest } from "@/lib/backend/proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteContext {
  readonly params: Promise<{ readonly sessionId: string }>;
}

/**
 * Run one turn and stream the backend's native Responses events to the browser.
 *
 * The upstream body is returned as a live stream rather than being read into memory first.
 * Buffering here would silently convert the streaming endpoint into a slow non-streaming
 * one, so the pass-through in the gateway is load-bearing rather than an optimisation.
 *
 * Event names and payload shapes are not translated. What the backend emits is what the
 * browser parses.
 */
export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const { sessionId } = await context.params;
  return proxySessionRequest(request, sessionId, BACKEND_ROUTES.responsesStream, {
    streaming: true,
  });
}
