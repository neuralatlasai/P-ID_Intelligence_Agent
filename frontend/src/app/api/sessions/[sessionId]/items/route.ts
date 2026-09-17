import { BACKEND_ROUTES, proxySessionRequest } from "@/lib/backend/proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteContext {
  readonly params: Promise<{ readonly sessionId: string }>;
}

/**
 * Read the session's persisted conversation items.
 *
 * The backend is the authority on conversation history. The browser reads it here on load,
 * and again after every completed run so the transcript it shows is the transcript that
 * was actually saved rather than the one it assembled from stream deltas.
 */
export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const { sessionId } = await context.params;
  return proxySessionRequest(request, sessionId, BACKEND_ROUTES.items);
}
